// The IGDB proxy (G1, next-gen item 5): the page's only way to IGDB. IGDB refuses requests from browsers and needs an app
// token made from a client secret, which must never reach the public page. This function holds the secret (Supabase function
// secrets IGDB_CLIENT_ID and IGDB_CLIENT_SECRET), answers only signed-in library members, and passes on read-only queries to an
// allow-list of IGDB endpoints. It stores nothing and logs no query.
//
// Membership is checked through the interface the page itself uses: the caller's own token and the project's publishable key,
// sent to PostgREST's rpc/stage5_capabilities, which is executable by signed-in users only and answers member: true for a member.
// PostgREST validates the token (whatever signing keys the project uses), so the platform's own JWT check can stay off.
// Answers: 401 signed out or an invalid token; 403 signed in but not a member; 400 a request outside the allow-list; 502 when
// IGDB or Twitch can't be reached or refuse. Pure: everything it reaches goes through deps.fetch (tests pass a fake).

export const ENDPOINTS = ['games', 'release_dates', 'collections', 'collection_memberships', 'platforms', 'franchises', 'external_games'];
export const MAX_QUERIES = 10;
export const MAX_BODY = 8000;
const TOKEN_URL_DEFAULT = 'https://id.twitch.tv/oauth2/token';
const IGDB_BASE_DEFAULT = 'https://api.igdb.com/v4';
const SPACING_MS = 260; // under IGDB's 4 requests per second

const CORS = {
  'Access-Control-Allow-Origin': '*', // the caller's token is the credential; no cookies are used
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600'
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// A query the proxy passes on: a known endpoint, an Apicalypse body of bounded size that only reads (fields / where / search /
// sort / limit / offset / exclude), and a limit of at most 500.
export function queryProblem(q) {
  if (!q || typeof q !== 'object') return 'not an object';
  if (!ENDPOINTS.includes(q.endpoint)) return `endpoint ${JSON.stringify(q.endpoint)} isn’t allowed`;
  if (typeof q.body !== 'string' || !q.body.trim() || q.body.length > MAX_BODY) return 'body missing or too long';
  const clauses = q.body.split(';').map(s => s.trim()).filter(Boolean);
  for (const c of clauses) {
    const word = c.split(/\s+/)[0].toLowerCase();
    if (!['fields', 'f', 'where', 'w', 'search', 'sort', 's', 'limit', 'l', 'offset', 'o', 'exclude', 'x'].includes(word)) return `clause “${word}” isn’t allowed`;
    if ((word === 'limit' || word === 'l') && !(Number(c.split(/\s+/)[1]) >= 1 && Number(c.split(/\s+/)[1]) <= 500)) return 'limit must be 1 to 500';
  }
  if (typeof q.name !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(q.name)) return 'name missing';
  return null;
}

// The member check (see the header). Returns null when the caller is a member, else the Response to send.
export async function memberCheck(req, env, deps) {
  const auth = req.headers.get('authorization') || '';
  const apikey = req.headers.get('apikey') || env.SUPABASE_ANON_KEY || '';
  const m = /^Bearer\s+(\S+)$/.exec(auth);
  if (!m || !apikey || m[1] === apikey) return json(401, { error: 'not_signed_in', message: 'Sign in to search IGDB.' });
  let res;
  try {
    res = await deps.fetch(`${env.SUPABASE_URL}/rest/v1/rpc/stage5_capabilities`, { headers: { apikey, Authorization: `Bearer ${m[1]}`, Accept: 'application/json' } });
  } catch (e) { return json(502, { error: 'membership_unknown', message: 'Your membership couldn’t be checked. Try again.' }); }
  if (res.status === 401 || res.status === 403) return json(401, { error: 'not_signed_in', message: 'Sign in to search IGDB.' });
  if (!res.ok) return json(502, { error: 'membership_unknown', message: 'Your membership couldn’t be checked. Try again.' });
  let cap = null;
  try { cap = await res.json(); } catch (e) { cap = null; }
  if (!cap || cap.member !== true) return json(403, { error: 'not_a_member', message: 'This account has no library here.' });
  return null;
}

// The app token, kept while it is valid (a module-level cache; a cold start makes a new one).
let cached = null;
export function resetTokenCache() { cached = null; }
async function appToken(env, deps, now) {
  if (cached && cached.expires > now + 60000) return cached.token;
  if (!env.IGDB_CLIENT_ID || !env.IGDB_CLIENT_SECRET) throw new Error('igdb_not_configured');
  const body = new URLSearchParams({ client_id: env.IGDB_CLIENT_ID, client_secret: env.IGDB_CLIENT_SECRET, grant_type: 'client_credentials' });
  const res = await deps.fetch(env.IGDB_TOKEN_URL || TOKEN_URL_DEFAULT, { method: 'POST', body });
  if (!res.ok) throw new Error(`token_refused_${res.status}`);
  const j = await res.json();
  if (!j || !j.access_token) throw new Error('token_missing');
  cached = { token: j.access_token, expires: now + Math.max(0, Number(j.expires_in) || 0) * 1000 };
  return cached.token;
}

async function igdb(env, deps, q, now, retried = false) {
  const token = await appToken(env, deps, now);
  const res = await deps.fetch(`${env.IGDB_BASE || IGDB_BASE_DEFAULT}/${q.endpoint}`, {
    method: 'POST', headers: { 'Client-ID': env.IGDB_CLIENT_ID, Authorization: `Bearer ${token}`, Accept: 'application/json' }, body: q.body });
  if (res.status === 401 && !retried) { cached = null; return igdb(env, deps, q, now, true); }
  if (res.status === 429 && !retried) { await deps.sleep(1000); return igdb(env, deps, q, now, true); }
  if (!res.ok) return { name: q.name, error: `igdb_${res.status}` };
  return { name: q.name, data: await res.json() };
}

export async function handle(req, env, deps) {
  const d = { sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now(), ...deps };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const refused = await memberCheck(req, env, d);
  if (refused) return refused;
  let body;
  try { body = await req.json(); } catch (e) { return json(400, { error: 'invalid_request', message: 'The request isn’t JSON.' }); }
  const queries = body && Array.isArray(body.queries) ? body.queries : null;
  if (!queries || !queries.length || queries.length > MAX_QUERIES) return json(400, { error: 'invalid_request', message: `Send 1 to ${MAX_QUERIES} queries.` });
  for (const q of queries) {
    const p = queryProblem(q);
    if (p) return json(400, { error: 'invalid_request', message: p });
  }
  const results = [];
  try {
    for (let i = 0; i < queries.length; i++) {
      if (i) await d.sleep(SPACING_MS);
      results.push(await igdb(env, d, queries[i], d.now()));
    }
  } catch (e) {
    const m = String(e && e.message || e);
    return json(502, { error: m === 'igdb_not_configured' ? 'igdb_not_configured' : 'igdb_unreachable', message: 'IGDB couldn’t be reached. Try again later.' });
  }
  return json(200, { results });
}
