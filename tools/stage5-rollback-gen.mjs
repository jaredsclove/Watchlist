// Generates the two catalog sections of db/rollback/phase5c.sql from local replicas
// (PGlite, no network): it builds the Stage 5a schema from the committed db/
// files, records every function, trigger and view definition and the
// othertv_shows table definition, applies db/phase5c_contract.sql, and writes SQL
// that puts back exactly what the contraction changed or removed:
//   GENERATED-OTHERTV  othertv_shows: columns, keys, indexes, row security,
//                      policies and grants as in Stage 5a (rows: from the archive);
//   GENERATED-CATALOG  triggers the contraction added or changed (dropped), the
//                      read views, every function it added (dropped) or changed /
//                      removed (recreated verbatim, with its grants), and the
//                      Stage 5a triggers (recreated).
// Usage:
//   PGLITE_DIR=<dir> node tools/stage5-rollback-gen.mjs <format-3 backup.json> [--write | --check]
// --write replaces the sections in db/rollback/phase5c.sql; --check exits 1 if
// they differ from a fresh generation (the rehearsal runs it). Definitions don't
// depend on the backup's rows; any valid format-3 backup will do.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const { buildReplica } = await import(path.join(ROOT, 'tools', 'db-rehearsal-3b2.mjs'));

export async function generateSections(backup) {
  const { db } = await buildReplica(backup);
  const q = async (s, p) => (await db.query(s, p)).rows;
  for (const f of ['db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql', 'db/phase5a_expand.sql']) await db.exec(sql(f));

  const FN = `select p.oid::regprocedure::text sig, n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' name,
      pg_get_function_arguments(p.oid) args, pg_get_functiondef(p.oid) def, coalesce(p.proacl::text, '') acl, p.prokind
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') order by 2`;
  const TG = `select t.tgname, t.tgrelid::regclass::text tbl, pg_get_triggerdef(t.oid) def from pg_trigger t
    join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname in ('public', 'private') order by 2, 1`;
  const VW = `select viewname, definition from pg_views where schemaname = 'public' order by 1`;
  const fnA = await q(FN), tgA = await q(TG), vwA = await q(VW);

  // othertv_shows as Stage 5a has it.
  const cols = await q(`select column_name, data_type, is_nullable, column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'othertv_shows' order by ordinal_position`);
  const cons = await q(`select conname, pg_get_constraintdef(oid) def, contype from pg_constraint
    where conrelid = 'public.othertv_shows'::regclass and contype <> 'n' order by contype = 'p' desc, conname`);
  // (contype 'n': PostgreSQL 18 records NOT NULL as constraints; the column definitions carry it, valid on 17 too.)
  const idx = await q(`select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'othertv_shows'
    and indexname not in (select conname from pg_constraint where conrelid = 'public.othertv_shows'::regclass) order by 1`);
  const pols = await q(`select policyname, cmd, roles::text roles, qual, with_check, permissive from pg_policies
    where schemaname = 'public' and tablename = 'othertv_shows' order by 1`);
  const rls = (await q(`select relrowsecurity from pg_class where oid = 'public.othertv_shows'::regclass`))[0].relrowsecurity;
  const tgrants = await q(`select grantee, privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'othertv_shows' and grantee in ('anon', 'authenticated', 'service_role') order by 1, 2`);
  const cgrants = await q(`select grantee, privilege_type, column_name from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'othertv_shows' and grantee in ('anon', 'authenticated', 'service_role')
    order by 1, 2, column_name`);

  await db.exec(sql('db/phase5c_contract.sql'));
  const fnC = await q(FN), tgC = await q(TG);
  await db.close();

  const byName = rows => new Map(rows.map(r => [r.name, r]));
  const A = byName(fnA), C = byName(fnC);
  const tgKey = t => `${t.tbl}.${t.tgname}`;
  const TA = new Map(tgA.map(t => [tgKey(t), t])), TC = new Map(tgC.map(t => [tgKey(t), t]));

  // ── othertv_shows ──
  const colSql = cols.map(c => `  ${c.column_name} ${c.data_type}${c.column_default ? ` default ${c.column_default}` : ''}${c.is_nullable === 'NO' ? ' not null' : ''}`);
  const consSql = cons.map(c => `  constraint ${c.conname} ${c.def}`);
  const o = [];
  o.push(`create table public.othertv_shows (\n${[...colSql, ...consSql].join(',\n')}\n);`);
  for (const i of idx) o.push(`${i.indexdef};`);
  if (rls) o.push('alter table public.othertv_shows enable row level security;');
  for (const p of pols) {
    const roles = p.roles.replace(/^\{|\}$/g, '');
    o.push(`create policy ${p.policyname} on public.othertv_shows as ${p.permissive.toLowerCase()} for ${p.cmd.toLowerCase()} to ${roles}` +
      `${p.qual ? ` using (${p.qual})` : ''}${p.with_check ? ` with check (${p.with_check})` : ''};`);
  }
  o.push('revoke all on public.othertv_shows from public, anon, authenticated, service_role;');
  const tg = new Map();
  for (const g of tgrants) { if (!tg.has(g.grantee)) tg.set(g.grantee, []); tg.get(g.grantee).push(g.privilege_type.toLowerCase()); }
  for (const [who, privs] of tg) {
    const colPrivs = new Set(cgrants.filter(c => c.grantee === who).map(c => c.privilege_type.toLowerCase()));
    const table = privs.filter(p => !(colPrivs.has(p) && cgrants.filter(c => c.grantee === who && c.privilege_type.toLowerCase() === p).length < cols.length));
    if (table.length) o.push(`grant ${table.join(', ')} on public.othertv_shows to ${who};`);
  }
  const colGroups = new Map();
  for (const c of cgrants) {
    const tablePriv = (tg.get(c.grantee) || []).includes(c.privilege_type.toLowerCase())
      && cgrants.filter(x => x.grantee === c.grantee && x.privilege_type === c.privilege_type).length === cols.length;
    if (tablePriv) continue;
    const k = `${c.grantee}|${c.privilege_type.toLowerCase()}`;
    if (!colGroups.has(k)) colGroups.set(k, []);
    colGroups.get(k).push(c.column_name);
  }
  for (const [k, list] of colGroups) {
    const [who, priv] = k.split('|');
    o.push(`grant ${priv} (${list.join(', ')}) on public.othertv_shows to ${who};`);
  }

  // ── functions, views, triggers ──
  const out = [];
  out.push('-- Triggers the contraction added or changed.');
  for (const [k, t] of TC) if (!TA.has(k) || TA.get(k).def !== t.def) out.push(`drop trigger ${t.tgname} on ${t.tbl};`);
  out.push('-- The read views as Stage 5a defines them (over storage).');
  for (const v of vwA) {
    if (!/^library_/.test(v.viewname)) continue;
    out.push(`create or replace view public.${v.viewname} with (security_invoker = true) as\n${v.definition.trim().replace(/;$/, '')};`);
  }
  out.push('-- Functions the contraction added.');
  for (const [name, f] of C) if (!A.has(name)) out.push(`drop function ${f.sig};`);
  out.push('-- Functions the contraction changed or removed, verbatim from Stage 5a, with their grants');
  out.push('-- (bodies checked when they run, as pg_dump does: a SQL function may name one defined after it).');
  out.push('set local check_function_bodies = off;');
  const grantSql = f => {
    const lines = [`revoke all on function ${f.sig} from public, anon, authenticated, service_role;`];
    const entries = f.acl.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
    for (const e of entries) {
      const grantee = e.slice(0, e.indexOf('='));
      if (grantee === 'postgres') continue;
      lines.push(`grant execute on function ${f.sig} to ${grantee === '' ? 'public' : grantee};`);
    }
    return lines;
  };
  for (const [name, f] of A) {
    const c = C.get(name);
    if (c && c.def === f.def && c.acl === f.acl) continue;
    if (c && c.args !== f.args) out.push(`drop function ${c.sig};`);
    out.push(`${f.def.trim()};`);
    if (f.acl) out.push(...grantSql(f));
  }
  out.push('set local check_function_bodies = on;');
  out.push('-- Stage 5a triggers.');
  for (const [k, t] of TA) if (!TC.has(k) || TC.get(k).def !== t.def) out.push(`${t.def};`);
  return { othertv: o.join('\n'), catalog: out.join('\n') };
}

function replaceSection(text, name, body) {
  const re = new RegExp(`(-- BEGIN ${name}\\n)[\\s\\S]*?(-- END ${name})`);
  if (!re.test(text)) throw new Error(`section ${name} not found`);
  return text.replace(re, (m, open, close) => `${open}${body}\n${close}`); // a function: bodies contain $$
}

export function sectionsOf(text) {
  const get = name => (text.match(new RegExp(`-- BEGIN ${name}\\n([\\s\\S]*?)\\n-- END ${name}`)) || [])[1];
  return { othertv: get('GENERATED-OTHERTV'), catalog: get('GENERATED-CATALOG') };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const mode = args.includes('--write') ? 'write' : args.includes('--check') ? 'check' : 'print';
  const backupPath = args.find(a => !a.startsWith('--'));
  if (!backupPath) { console.error('usage: node tools/stage5-rollback-gen.mjs <format-3 backup.json> [--write | --check]'); process.exit(2); }
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const g = await generateSections(backup);
  const file = path.join(ROOT, 'db', 'rollback', 'phase5c.sql');
  if (mode === 'print') { console.log(g.othertv); console.log(g.catalog); }
  else if (mode === 'write') {
    let t = fs.readFileSync(file, 'utf8');
    t = replaceSection(t, 'GENERATED-OTHERTV', g.othertv);
    t = replaceSection(t, 'GENERATED-CATALOG', g.catalog);
    fs.writeFileSync(file, t);
    console.log('db/rollback/phase5c.sql sections written');
  } else {
    const cur = sectionsOf(fs.readFileSync(file, 'utf8'));
    const same = cur.othertv === g.othertv && cur.catalog === g.catalog;
    console.log(same ? 'db/rollback/phase5c.sql sections are current' : 'db/rollback/phase5c.sql sections DIFFER from a fresh generation');
    process.exitCode = same ? 0 : 1;
  }
}
