// M1 Phase B1 (local Supabase stack only; refuses any address but 127.0.0.1): real Auth and PostgREST.
//   node tools/m1-local-auth-test.mjs --api http://127.0.0.1:54321 --mail http://127.0.0.1:54324 --key <local publishable key>
//        --a <member A email> --b <member B email> --file-a synthetic-1.json --file-b synthetic-2.json [--expiry]
// Members sign in by emailed code, read from the local mail catcher (Mailpit); no password exists or is stored.
// Checks: code sign-in (shouldCreateUser false refuses an unknown address); the anonymous caller is refused
// (tables, views, functions, GraphQL); each member sees only their own rows; cross-member writes and functions
// change nothing; restore isolation; refresh; a signed-out (revoked) session can't refresh; with --expiry, a write
// with an expired access token is refused before it runs (401) and changes nothing.
// Output: pass/fail and counts only; tokens are never printed.
import crypto from 'crypto';
import fs from 'fs';

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const API = opt('--api'), MAIL = opt('--mail'), KEY = opt('--key');
for (const u of [API, MAIL]) if (!u || new URL(u).hostname !== '127.0.0.1') { console.error('local stack only: --api and --mail must be http://127.0.0.1:…'); process.exit(2); }
const EA = opt('--a'), EB = opt('--b');
const fileA = JSON.parse(fs.readFileSync(opt('--file-a'), 'utf8')), fileB = JSON.parse(fs.readFileSync(opt('--file-b'), 'utf8'));
const TABLES = ['watchlist_items', 'tv_shows', 'custom_collections', 'personal_collections', 'collection_memberships', 'watch_with_choices', 'catalog_show_links', 'catalog_film_links'];
const VIEWS = ['library_catalog_shows', 'library_catalog_films', 'library_collection_catalogs', 'library_collection_presentation', 'library_film_theme_kinds'];

let passed = 0, failed = 0;
const scrub = s => String(s || '').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]').slice(0, 300);
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${scrub(e && e.message)}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
async function call(token, method, path, body, extra = {}) {
  const res = await fetch(`${API}/${path}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${token || KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}
const rest = (t, m, p, b, x) => call(t, m, `rest/v1/${p}`, b, x);
const rpc = (t, fn, args) => rest(t, 'POST', `rpc/${fn}`, args);
const denied = r => !r.ok && (r.status === 401 || r.status === 403 || /42501|permission denied|PGRST30\d/.test(r.text));
async function rows(t, table) { const r = await rest(t, 'GET', `${table}?select=*&order=id.asc`); if (!r.ok) throw new Error(`${table}: ${r.status} ${r.text}`); return r.json; }
async function fingerprint(t) {
  const parts = []; for (const tb of TABLES) parts.push(tb + ':' + JSON.stringify((await rows(t, tb)).map(r => JSON.stringify(r)).sort()));
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// ── Sign-in by emailed code (Mailpit) ──
async function latestCode(email, after) {
  for (let i = 0; i < 40; i++) {
    const s = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent('to:' + email)}`)).json();
    const m = (s.messages || []).filter(x => new Date(x.Created) > after).sort((a, b) => new Date(b.Created) - new Date(a.Created))[0];
    if (m) {
      const full = await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json();
      const code = (String(full.Text || '') + ' ' + String(full.HTML || '')).match(/\b(\d{6})\b/);
      if (code) return code[1];
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`no code email for ${email}`);
}
async function signInByCode(email) {
  const t0 = new Date(Date.now() - 1000);
  const o = await call(null, 'POST', 'auth/v1/otp', { email, create_user: false });
  if (!o.ok) throw new Error(`otp ${o.status} ${o.text}`);
  const code = await latestCode(email, t0);
  const v = await call(null, 'POST', 'auth/v1/verify', { type: 'email', email, token: code });
  if (!v.ok || !v.json.access_token) throw new Error(`verify ${v.status} ${v.text}`);
  return v.json;
}

console.log('[sign-in by code]');
let sa, sb;
await test('an unknown address gets no code and no account (sign-ups off, create_user false)', async () => {
  const r = await call(null, 'POST', 'auth/v1/otp', { email: `nobody-${Date.now()}@test.local`, create_user: false });
  assert(!r.ok, `${r.status} ${r.text}`);
});
await test('member A signs in with the emailed code', async () => { sa = await signInByCode(EA); assert(sa.user.email === EA, 'wrong user'); });
await test('member B signs in with the emailed code', async () => { sb = await signInByCode(EB); assert(sb.user.email === EB, 'wrong user'); });
if (!sa || !sb) { console.log(`\nFAILED: ${failed}`); process.exit(1); }
const A = sa.user.id, B = sb.user.id;

console.log('\n[anonymous caller]');
for (const t of TABLES.concat(VIEWS)) await test(`anon: read ${t} refused`, async () => { const r = await rest(null, 'GET', `${t}?select=*&limit=1`); assert(denied(r), `${r.status} ${r.text}`); });
await test('anon: insert refused', async () => { const r = await rest(null, 'POST', 'custom_collections', [{ name: 'zz' }]); assert(denied(r), `${r.status} ${r.text}`); });
await test('anon: rpc restore_backup refused', async () => { const r = await rpc(null, 'restore_backup', { p_backup: fileA, p_allow_v1_reset: false }); assert(denied(r) || r.status === 404, `${r.status} ${r.text}`); });
await test('anon: GraphQL sees no app table', async () => { const r = await call(null, 'POST', 'graphql/v1', { query: '{ watchlist_itemsCollection(first: 1) { edges { node { id } } } }' }); assert(!JSON.stringify(r.json || {}).includes('"node"'), `${r.status} ${r.text.slice(0, 200)}`); });
await test('the private schema isn’t reachable through the API, even for a member', async () => { const r = await rest(sa.access_token, 'GET', 'stage5_recovery_records?select=*&limit=1', undefined, { 'Accept-Profile': 'private' }); assert(!r.ok, `${r.status} ${r.text}`); });

console.log('\n[two members]');
if ((await rows(sb.access_token, 'tv_shows')).length === 0) {
  await test('B restores B’s synthetic library (as the page does)', async () => { const r = await rpc(sb.access_token, 'restore_backup', { p_backup: fileB, p_allow_v1_reset: false }); assert(r.ok, `${r.status} ${r.text}`); });
}
for (const t of TABLES) await test(`${t}: A sees only A’s rows, B only B’s`, async () => {
  const ra = await rows(sa.access_token, t), rb = await rows(sb.access_token, t);
  assert(ra.every(r => r.user_id === A) && rb.every(r => r.user_id === B), 'a row of the other member is visible');
  if (['watchlist_items', 'tv_shows'].includes(t)) assert(ra.length > 0 && rb.length > 0, `counts A ${ra.length}, B ${rb.length}`);
});
const ta = sa.access_token, tb = sb.access_token;
const aItems = await rows(ta, 'watchlist_items'), aShows = await rows(ta, 'tv_shows'), aColls = await rows(ta, 'personal_collections'), bColls = await rows(tb, 'personal_collections');
const aFilm = aItems.find(r => r.is_film), aSeason = aItems.find(r => !r.is_film);
for (const v of VIEWS) await test(`view ${v}: B sees none of A’s ids`, async () => { const r = await rest(tb, 'GET', `${v}?select=id&id=in.(${[aFilm.id, aShows[0].id, aColls[0].id].join(',')})`); assert(r.ok && r.json.length === 0, `${r.status} ${r.text}`); });
const fpA = await fingerprint(ta), fpB = await fingerprint(tb);
const refused = r => !r.ok || /"ok":\s*false|refus|not found/i.test(r.text);
await test('B: update of A’s show changes nothing', async () => { const r = await rest(tb, 'PATCH', `tv_shows?id=eq.${aShows[0].id}`, { title: 'zz' }); assert(!r.ok || r.json.length === 0, `${r.status} ${r.text}`); });
await test('B: delete of A’s film changes nothing', async () => { const r = await rest(tb, 'DELETE', `watchlist_items?id=eq.${aFilm.id}`); assert(!r.ok || r.json.length === 0, `${r.status} ${r.text}`); });
await test('B: an insert naming A as owner is refused', async () => { const r = await rest(tb, 'POST', 'custom_collections', [{ name: 'zz forged', user_id: A }]); assert(!r.ok, `${r.status} ${r.text}`); });
await test('B: adding A’s show to B’s collection is refused', async () => assert(refused(await rpc(tb, 'org_add_membership', { p_collection_id: bColls[0].id, p_show_id: aShows[0].id, p_item_id: null })), 'accepted'));
await test('B: renaming A’s collection is refused', async () => assert(refused(await rpc(tb, 'org_rename_collection', { p_id: aColls[0].id, p_expected_name: aColls[0].name, p_name: 'zz' })), 'accepted'));
await test('B: setting A’s film state is refused', async () => assert(refused(await rpc(tb, 'library_set_film_state_b45', { p_item_id: aFilm.id, p_expected: {}, p_changes: { priority: 'high' } })), 'accepted'));
await test('B: deleting A’s season is refused', async () => { const r = await rpc(tb, 'delete_tv_season', { p_row_id: aSeason.id }); assert(!r.ok || /false|refus|not found/i.test(r.text), `${r.status} ${r.text}`); });
await test('both libraries unchanged by B’s attempts', async () => assert(fpA === await fingerprint(ta) && fpB === await fingerprint(tb), 'a library changed'));
await test('B restoring A’s file is refused; nothing changed', async () => { const r = await rpc(tb, 'restore_backup', { p_backup: fileA, p_allow_v1_reset: false }); assert(!r.ok, `${r.status}`); assert(fpA === await fingerprint(ta) && fpB === await fingerprint(tb), 'a library changed'); });
await test('A restores A’s file; B unchanged', async () => { const r = await rpc(ta, 'restore_backup', { p_backup: fileA, p_allow_v1_reset: false }); assert(r.ok, `${r.status} ${r.text}`); assert(fpB === await fingerprint(tb), 'B changed'); });

console.log('\n[sessions]');
await test('A’s refresh token gives a new access token', async () => { const r = await call(null, 'POST', 'auth/v1/token?grant_type=refresh_token', { refresh_token: sa.refresh_token }); assert(r.ok && r.json.access_token, `${r.status}`); sa = r.json; });
await test('after B signs out (all sessions), B’s refresh token no longer works', async () => {
  const o = await call(sb.access_token, 'POST', 'auth/v1/logout?scope=global', {}); assert(o.ok || o.status === 204, `logout ${o.status}`);
  const r = await call(null, 'POST', 'auth/v1/token?grant_type=refresh_token', { refresh_token: sb.refresh_token }); assert(!r.ok, `refresh ${r.status}`);
});
if (argv.includes('--expiry')) {
  const held = sa.access_token, before = await fingerprint(held);
  const exp = JSON.parse(Buffer.from(held.split('.')[1], 'base64url').toString()).exp;
  // PostgREST accepts a token for a short clock-skew allowance after exp; wait well past it.
  const waitMs = Math.max(0, exp * 1000 - Date.now() + 45000);
  console.log(`  …  waiting ${Math.round(waitMs / 1000)} s for A’s access token to expire`);
  await new Promise(r => setTimeout(r, waitMs));
  await test('a write with an expired access token (45 s past exp): 401 before running; nothing changed', async () => {
    const r = await rest(held, 'PATCH', `tv_shows?id=eq.${aShows[0].id}`, { title: 'zz expired' });
    assert(r.status === 401 && /PGRST30\d|expired/i.test(r.text), `${r.status} ${r.text}`);
    const fresh = (await call(null, 'POST', 'auth/v1/token?grant_type=refresh_token', { refresh_token: sa.refresh_token })).json;
    assert(fresh && fresh.access_token && before === await fingerprint(fresh.access_token), 'changed');
  });
}
console.log(`\n${failed ? `FAILED: ${failed}` : 'all local auth checks passed'} (${passed} passed)`);
process.exitCode = failed ? 1 : 0;
