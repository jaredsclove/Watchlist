// Offline tests for the IGDB proxy's logic (supabase/functions/igdb/core.mjs, G1) with a fake network: who may use it (signed
// out, a token that isn't a session, a signed-in non-member, a member), the allow-list of endpoints and clauses, the app token
// (made once, kept, made again when IGDB refuses it), rate-limit spacing and retries, and that no secret or token reaches an
// answer. The local stack test (tools/g1-local-api-test.mjs) runs the same function under Supabase with real Auth.
// Run from the repo root: node tests/igdb-proxy.test.mjs
import { handle, queryProblem, resetTokenCache, ENDPOINTS } from '../supabase/functions/igdb/core.mjs';

let passed = 0, failed = 0;
const ok = (c, label, detail = '') => { c ? passed++ : failed++; if (!c) console.log(`  FAIL ${label}${detail ? `\n       ${String(detail).slice(0, 400)}` : ''}`); };
const ENV = { SUPABASE_URL: 'https://zz.supabase.test', IGDB_CLIENT_ID: 'zz-client', IGDB_CLIENT_SECRET: 'zz-secret-value', IGDB_BASE: 'https://igdb.test/v4', IGDB_TOKEN_URL: 'https://twitch.test/token' };
const KEY = 'sb_publishable_zz', MEMBER = 'eyJ.member.token', OUTSIDER = 'eyJ.outsider.token';

// The fake network: PostgREST answers membership by token; Twitch issues tokens; IGDB answers by endpoint.
function network(o = {}) {
  const log = [];
  let tokens = 0;
  const fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    log.push({ url: String(url), headers, body: init.body });
    if (String(url).startsWith(`${ENV.SUPABASE_URL}/rest/v1/rpc/stage5_capabilities`)) {
      const auth = headers.Authorization;
      if (auth === `Bearer ${MEMBER}`) return new Response(JSON.stringify({ member: true, phase: 'contracted-g1' }), { status: 200 });
      if (auth === `Bearer ${OUTSIDER}`) return new Response(JSON.stringify({ member: false, phase: 'contracted-g1' }), { status: 200 });
      return new Response(JSON.stringify({ code: 'PGRST301', message: 'JWT invalid' }), { status: 401 });
    }
    if (String(url) === ENV.IGDB_TOKEN_URL) {
      tokens++;
      if (o.tokenRefused) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ access_token: `app-token-${tokens}`, expires_in: 5000000, token_type: 'bearer' }), { status: 200 });
    }
    if (String(url).startsWith(ENV.IGDB_BASE)) {
      if (o.igdbStatus) { const s = o.igdbStatus.shift(); if (s) return new Response('[]', { status: s }); }
      return new Response(JSON.stringify([{ id: 1, name: 'ZZ Game', endpoint: String(url).split('/').pop() }]), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, log, tokens: () => tokens, sleeps: [], deps() { const self = this; return { fetch, sleep: async ms => { self.sleeps.push(ms); }, now: () => 1000 }; } };
}
const req = (token, body, method = 'POST', key = KEY) => new Request('https://fn.test/igdb', { method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { apikey: key } : {}), 'Content-Type': 'application/json' },
  body: method === 'POST' ? JSON.stringify(body) : undefined });
const Q = (name, endpoint, body) => ({ name, endpoint, body });
const search = { queries: [Q('search', 'games', 'search "ZZ War"; fields id,name; limit 20;')] };
const answer = async r => ({ status: r.status, body: await r.json().catch(() => null), cors: r.headers.get('access-control-allow-origin') });

// ── Who may use it ──
{
  resetTokenCache();
  const n = network();
  const r = await answer(await handle(req(null, search), ENV, n.deps()));
  ok(r.status === 401 && r.body.error === 'not_signed_in' && n.log.length === 0, 'signed out (no token): 401, nothing reached');
  const k = await answer(await handle(req(KEY, search), ENV, n.deps()));
  ok(k.status === 401 && n.log.length === 0, 'the publishable key sent as the token: 401, nothing reached');
  const bad = await answer(await handle(req('eyJ.not.valid', search), ENV, n.deps()));
  ok(bad.status === 401 && n.log.length === 1 && !n.log.some(l => l.url.startsWith(ENV.IGDB_BASE)), 'a token PostgREST refuses: 401, IGDB not reached');
  const out = await answer(await handle(req(OUTSIDER, search), ENV, n.deps()));
  ok(out.status === 403 && out.body.error === 'not_a_member' && !n.log.some(l => l.url.startsWith(ENV.IGDB_BASE)) && n.tokens() === 0, 'signed in, not a member: 403, IGDB not reached, no app token made');
  const m = await answer(await handle(req(MEMBER, search), ENV, n.deps()));
  ok(m.status === 200 && m.body.results[0].name === 'search' && m.body.results[0].data[0].name === 'ZZ Game', 'a member: the query is answered', JSON.stringify(m.body));
  const check = n.log.find(l => l.url.includes('stage5_capabilities') && l.headers.Authorization === `Bearer ${MEMBER}`);
  ok(check && check.headers.apikey === KEY, 'membership is asked of PostgREST with the caller’s own token and the publishable key');
  ok(m.cors === '*', 'answers carry CORS headers for the page');
  const pre = await handle(req(null, null, 'OPTIONS'), ENV, n.deps());
  ok(pre.status === 204 && /authorization/.test(pre.headers.get('access-control-allow-headers')), 'a preflight is answered without a check');
  ok((await handle(req(MEMBER, null, 'GET'), ENV, n.deps())).status === 405, 'only POST');
}

// ── The allow-list ──
{
  resetTokenCache();
  const n = network();
  const send = async body => answer(await handle(req(MEMBER, body), ENV, n.deps()));
  for (const [label, body] of [
    ['an unknown endpoint', { queries: [Q('x', 'private_endpoint', 'fields *;')] }],
    ['no queries', { queries: [] }], ['too many queries', { queries: Array.from({ length: 11 }, (_, i) => Q(`q${i}`, 'games', 'fields id;')) }],
    ['a body too long', { queries: [Q('x', 'games', `fields ${'a,'.repeat(5000)}id;`)] }],
    ['an unknown clause', { queries: [Q('x', 'games', 'fields id; delete everything;')] }],
    ['a limit over 500', { queries: [Q('x', 'games', 'fields id; limit 501;')] }], ['a query without a name', { queries: [{ endpoint: 'games', body: 'fields id;' }] }],
    ['not JSON', null]]) {
    const r = body === null ? await answer(await handle(new Request('https://fn.test/igdb', { method: 'POST', headers: { Authorization: `Bearer ${MEMBER}`, apikey: KEY }, body: 'not json' }), ENV, n.deps())) : await send(body);
    ok(r.status === 400 && r.body.error === 'invalid_request', `${label}: refused`, JSON.stringify(r.body));
  }
  ok(!n.log.some(l => l.url.startsWith(ENV.IGDB_BASE)), 'none of them reached IGDB');
  ok(ENDPOINTS.every(e => queryProblem(Q('n', e, 'fields id; where id = (1,2); sort id asc; limit 500; offset 0;')) === null), 'every allowed endpoint takes an ordinary read');
  ok(queryProblem(Q('n', 'games', 'search "ZZ"; fields name;')) === null, 'search is allowed');
  const big = `fields id,name,slug,game_type,game_status,first_release_date,parent_game,version_parent,ports,remasters,remakes,collections.name,franchises.name,genres.name,aggregated_rating,aggregated_rating_count,rating,rating_count,external_games.external_game_source,external_games.url,release_dates.platform,release_dates.date,release_dates.y,release_dates.m,release_dates.date_format,release_dates.status,release_dates.release_region; where id = (${Array.from({ length: 400 }, (_, i) => 9000000 + i).join(',')}); limit 500;`;
  ok(queryProblem(Q('n', 'games', big)) === null, `a full page batch (400 seven-digit ids, every field the page asks for: ${big.length} characters) is allowed`);
}

// ── The app token, spacing and retries ──
{
  resetTokenCache();
  const n = network();
  const many = { queries: [Q('a', 'games', 'fields id;'), Q('b', 'release_dates', 'fields id;'), Q('c', 'collection_memberships', 'fields id;')] };
  const r = await answer(await handle(req(MEMBER, many), ENV, n.deps()));
  ok(r.status === 200 && r.body.results.map(x => x.name).join() === 'a,b,c' && n.tokens() === 1, 'several queries, in order, with one app token');
  ok(n.sleeps.filter(ms => ms === 260).length === 2, 'they are spaced under IGDB’s rate limit');
  await handle(req(MEMBER, search), ENV, n.deps());
  ok(n.tokens() === 1, 'the token is kept for the next request');
  const igdbCall = n.log.find(l => l.url.startsWith(ENV.IGDB_BASE));
  ok(igdbCall.headers['Client-ID'] === ENV.IGDB_CLIENT_ID && igdbCall.headers.Authorization === 'Bearer app-token-1' && igdbCall.body === 'fields id;', 'IGDB gets the client id, the app token and the query as sent');
  const tokenCall = n.log.find(l => l.url === ENV.IGDB_TOKEN_URL);
  ok(tokenCall && !tokenCall.url.includes(ENV.IGDB_CLIENT_SECRET) && String(tokenCall.body).includes('client_credentials'), 'the secret goes in the token request’s body, never its address');
  ok(!JSON.stringify(r.body).includes(ENV.IGDB_CLIENT_SECRET) && !JSON.stringify(r.body).includes('app-token'), 'no secret or app token in an answer');
  resetTokenCache();
  const n2 = network({ igdbStatus: [401] });
  const r2 = await answer(await handle(req(MEMBER, search), ENV, n2.deps()));
  ok(r2.status === 200 && n2.tokens() === 2 && r2.body.results[0].data, 'a token IGDB refuses is made again once');
  const n3 = network({ igdbStatus: [429] });
  const r3 = await answer(await handle(req(MEMBER, search), ENV, n3.deps()));
  ok(r3.status === 200 && n3.sleeps.includes(1000), 'a rate-limited query waits a second and is sent once more');
  const n4 = network({ igdbStatus: [500] });
  const r4 = await answer(await handle(req(MEMBER, search), ENV, n4.deps()));
  ok(r4.status === 200 && r4.body.results[0].error === 'igdb_500', 'an IGDB error is reported per query');
  resetTokenCache();
  const n5 = network({ tokenRefused: true });
  const r5 = await answer(await handle(req(MEMBER, search), ENV, n5.deps()));
  ok(r5.status === 502 && r5.body.error === 'igdb_unreachable' && !JSON.stringify(r5.body).includes('secret'), 'a refused token: 502, nothing of the secret said');
  resetTokenCache();
  const r6 = await answer(await handle(req(MEMBER, search), { ...ENV, IGDB_CLIENT_SECRET: '' }, network().deps()));
  ok(r6.status === 502 && r6.body.error === 'igdb_not_configured', 'without secrets set: says it isn’t configured');
}

// ── Temporary compatibility: a page from before game length was removed ──
{
  resetTokenCache();
  const n = network();
  // That page's batch of records: games and time to beat together (its Refresh, add and follow).
  const old = { queries: [Q('g0', 'games', 'fields id,name; where id = (1); limit 500;'), Q('t0', 'game_time_to_beats', 'fields game_id,hastily,normally,completely,count; where game_id = (1); limit 500;')] };
  const r = await answer(await handle(req(MEMBER, old), ENV, n.deps()));
  ok(r.status === 200 && r.body.results.map(x => x.name).join() === 'g0,t0' && r.body.results[1].data.length === 0 && r.body.results[0].data[0].name === 'ZZ Game',
    'an older page’s records batch is answered: its games as usual, time to beat as an empty list', JSON.stringify(r.body));
  ok(n.log.filter(l => l.url.startsWith(ENV.IGDB_BASE)).map(l => l.url.split('/').pop()).join() === 'games', 'time to beat is never asked of IGDB');
  ok(n.sleeps.length === 0, 'and costs no rate-limit spacing');
  const only = await answer(await handle(req(MEMBER, { queries: [Q('t', 'game_time_to_beats', 'fields id;')] }), network().deps ? ENV : ENV, network().deps()));
  ok(only.status === 200 && only.body.results[0].data.length === 0, 'a time-to-beat query alone: an empty list');
  const out = await answer(await handle(req(null, old), ENV, network().deps()));
  ok(out.status === 401, 'still members only');
  ok(queryProblem(Q('t', 'game_time_to_beats', 'fields id; delete x;')) !== null, 'its body is still checked');
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
