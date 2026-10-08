// The payload hash of each built-in catalog at a commit (Stage 4a): the value the
// Catalog updates dialog shows as "Catalog version" and that db/phase4a_catalog.sql
// binds approval to. Loads that commit's config.js and catalog-apply.js in a vm
// (no network, no database) and hashes each collection's defaults canonically.
//   node tools/catalog-payload-hash.mjs [commit]    (default: the working tree)
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const commit = process.argv[2];
const read = f => (commit ? execSync(`git -C ${JSON.stringify(ROOT)} show ${commit}:${f}`, { encoding: 'utf8' }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
const ctx = { crypto: crypto.webcrypto, TextEncoder };
vm.createContext(ctx);
vm.runInContext(`${read('config.js')}\nthis.COLLECTIONS = COLLECTIONS;`, ctx, { filename: 'config.js' });
// The canonical form and hash as the app computes them (from the working tree's catalog-apply.js).
vm.runInContext(fs.readFileSync(path.join(ROOT, 'catalog-apply.js'), 'utf8'), ctx, { filename: 'catalog-apply.js' });
const fileHash = crypto.createHash('sha256').update(read('config.js'), 'utf8').digest('hex');
console.log(`config.js ${commit || '(working tree)'} file sha256 ${fileHash}`);
for (const c of ctx.COLLECTIONS.filter(x => Array.isArray(x.defaults) && x.defaults.length)) {
  console.log(`${c.id.padEnd(9)} ${String(c.defaults.length).padStart(3)} defaults  payload ${await ctx.catalogPayloadHash(JSON.parse(JSON.stringify(c.defaults)))}`);
}
