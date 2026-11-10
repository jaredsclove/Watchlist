// G1 (item 5) provider feasibility: read-only IGDB requests for a small public sample of games.
//   node tools/igdb-feasibility.mjs --env <file outside the repo> --out <directory outside the repo>
// The env file holds IGDB_CLIENT_ID=... and IGDB_CLIENT_SECRET=... (a Twitch developer app). Neither value, nor the app token,
// is ever printed or written; the token is revoked at the end. Every request is a read; results go to <out> as JSON, and a
// short summary is printed. Public catalogue data only: no library, member or account data is read or sent.
import fs from 'fs';
import path from 'path';

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const envFile = arg('--env'), outDir = arg('--out');
if (!envFile || !outDir) { console.error('usage: node tools/igdb-feasibility.mjs --env <file> --out <dir>'); process.exit(2); }

const env = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const CLIENT_ID = env.IGDB_CLIENT_ID, SECRET = env.IGDB_CLIENT_SECRET;
if (!CLIENT_ID || !SECRET) { console.error('The env file needs IGDB_CLIENT_ID and IGDB_CLIENT_SECRET (values not shown).'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let token = null;

async function getToken() {
  const body = new URLSearchParams({ client_id: CLIENT_ID, client_secret: SECRET, grant_type: 'client_credentials' });
  const r = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body });
  if (!r.ok) {
    // Twitch's refusal says which part is wrong ("invalid client", "invalid client secret"); it never echoes the values.
    const msg = await r.json().then(j => j.message, () => '');
    throw new Error(`token request refused: HTTP ${r.status}${msg ? ` (${String(msg).slice(0, 80)})` : ''}; ` +
      `client id ${CLIENT_ID.length} characters, secret ${SECRET.length} characters`);
  }
  const j = await r.json();
  token = j.access_token;
  return { expires_in_days: Math.round(j.expires_in / 86400), token_type: j.token_type };
}

async function revokeToken() {
  if (!token) return 'none';
  const body = new URLSearchParams({ client_id: CLIENT_ID, token });
  const r = await fetch('https://id.twitch.tv/oauth2/revoke', { method: 'POST', body });
  token = null;
  return r.ok ? 'revoked' : `revoke HTTP ${r.status}`;
}

let requests = 0;
async function q(endpoint, query, name) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(300); // under 4 requests per second
    requests++;
    const r = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: 'POST',
      headers: { 'Client-ID': CLIENT_ID, Authorization: `Bearer ${token}`, Accept: 'application/json' },
      body: query,
    });
    if (r.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
    const text = await r.text();
    if (!r.ok) throw new Error(`${name || endpoint}: HTTP ${r.status} ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    if (name) fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ endpoint, query, data }, null, 2));
    return data;
  }
  throw new Error(`${name || endpoint}: still rate limited`);
}

const RELEASE_FIELDS = 'release_dates.platform.name,release_dates.platform.abbreviation,release_dates.date,release_dates.y,release_dates.m,' +
  'release_dates.d,release_dates.human,release_dates.date_format.format,release_dates.status.name,release_dates.release_region.region,' +
  'release_dates.created_at,release_dates.updated_at';
const GAME_FIELDS = 'id,name,slug,game_type.type,game_status.status,first_release_date,created_at,updated_at,' +
  'franchise.name,franchises.name,collections.name,collections.type.name,parent_game.name,version_parent.name,version_title,' +
  'ports.name,remasters.name,remakes.name,platforms.abbreviation,genres.name,aggregated_rating,aggregated_rating_count,rating,rating_count,' +
  'external_games.external_game_source.name,external_games.uid,external_games.url,external_games.platform.abbreviation,' +
  'websites.url,websites.type.type,' + RELEASE_FIELDS;

// The public sample. Slugs as IGDB's site shows them; any that don't match are looked up by name below.
const SAMPLE = [
  ['call-of-duty-4-modern-warfare', 'Call of Duty 4: Modern Warfare'],
  ['call-of-duty-modern-warfare-remastered', 'Call of Duty: Modern Warfare Remastered'],
  ['call-of-duty-modern-warfare-reflex-edition', 'Call of Duty: Modern Warfare - Reflex Edition'],
  ['call-of-duty-modern-warfare', 'Call of Duty: Modern Warfare (2019)'],
  ['call-of-duty-modern-warfare-2', 'Call of Duty: Modern Warfare 2'],
  ['call-of-duty-modern-warfare-ii', 'Call of Duty: Modern Warfare II'],
  ['call-of-duty-wwii', 'Call of Duty: WWII'],
  ['call-of-duty-black-ops-6', 'Call of Duty: Black Ops 6'],
  ['call-of-duty-black-ops-7', 'Call of Duty: Black Ops 7'],
  ['resident-evil-4', 'Resident Evil 4 (2005)'],
  ['resident-evil-4--1', 'Resident Evil 4 (2023)'],
  ['cyberpunk-2077', 'Cyberpunk 2077'],
  ['ghost-of-yotei', 'Ghost of Yotei'],
  ['grand-theft-auto-vi', 'Grand Theft Auto VI'],
  ['intergalactic-the-heretic-prophet', 'Intergalactic: The Heretic Prophet'],
  ['the-last-of-us-part-ii-remastered', 'The Last of Us Part II Remastered'],
];

const pad = s => String(s ?? '');
const ymd = t => (t ? new Date(t * 1000).toISOString().slice(0, 10) : '');
const rowLine = rd => `${pad(rd.platform?.abbreviation || rd.platform?.name)} ${pad(rd.human)} [${pad(rd.date_format?.format)}] ` +
  `${pad(rd.status?.name) || 'no status'} ${pad(rd.release_region?.region)} created ${ymd(rd.created_at)} updated ${ymd(rd.updated_at)}`;

const summary = [];
const say = s => { summary.push(s); console.log(s); };

// Follow-up mode: --query <endpoint> <Apicalypse body> runs one more read and saves it as query.json.
const qi = process.argv.indexOf('--query');
if (qi > 0) {
  try {
    await getToken();
    const d = await q(process.argv[qi + 1], process.argv[qi + 2], 'query');
    console.log(JSON.stringify(d, null, 1).slice(0, 12000));
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 1; }
  finally { console.log(`token: ${await revokeToken()}`); }
  process.exit();
}

try {
  const t = await getToken();
  say(`token: ok (${t.token_type}, about ${t.expires_in_days} days)`);

  // Lookup tables: the real values behind the documented references.
  const lookups = {
    game_types: 'fields id,type; limit 100;',
    game_statuses: 'fields id,status; limit 100;',
    release_date_statuses: 'fields id,name,description; limit 100;',
    date_formats: 'fields id,format; limit 100;',
    collection_types: 'fields id,name,description; limit 100;',
    collection_membership_types: 'fields id,name,description,allowed_collection_type; limit 100;',
    collection_relation_types: 'fields id,name,description; limit 100;',
    external_game_sources: 'fields id,name; limit 200;',
    website_types: 'fields id,type; limit 100;',
  };
  for (const [ep, query] of Object.entries(lookups)) {
    const d = await q(ep, query, `lookup_${ep}`);
    say(`${ep}: ` + d.map(x => `${x.id}=${x.type || x.status || x.name || x.format}`).join(', '));
  }
  const plats = await q('platforms', 'fields id,name,abbreviation; where name ~ *"PlayStation"* | name ~ *"Switch"*; limit 50;', 'lookup_platforms');
  say('platforms: ' + plats.map(p => `${p.id}=${p.abbreviation || p.name}`).join(', '));

  // The sample games.
  const slugs = SAMPLE.map(s => `"${s[0]}"`).join(',');
  let games = await q('games', `fields ${GAME_FIELDS}; where slug = (${slugs}); limit 50;`, 'sample_games');
  for (const [slug, label] of SAMPLE) {
    if (games.some(g => g.slug === slug)) continue;
    const name = label.replace(/\s*\(\d{4}\)$/, '').replace(/"/g, '');
    const found = await q('games', `search "${name}"; fields ${GAME_FIELDS}; limit 3;`, `search_${slug}`);
    say(`slug ${slug} not found; search "${name}" gave: ${found.map(g => `${g.name} (${g.slug})`).join('; ') || 'nothing'}`);
    if (found[0]) games.push(found[0]);
  }

  // Related records: ports, remasters and remakes of the sample, with their own release rows.
  const relatedIds = [...new Set(games.flatMap(g => [...(g.ports || []), ...(g.remasters || []), ...(g.remakes || [])].map(x => x.id)))]
    .filter(id => !games.some(g => g.id === id));
  const related = relatedIds.length ? await q('games', `fields ${GAME_FIELDS}; where id = (${relatedIds.join(',')}); limit 100;`, 'related_games') : [];

  for (const g of [...games, ...related]) {
    say(`\n# ${g.name} (${g.slug}, id ${g.id}) type=${g.game_type?.type ?? '?'} status=${g.game_status?.status ?? 'none'} first=${ymd(g.first_release_date)}`);
    say(`  franchise=${g.franchise?.name ?? '-'} franchises=${(g.franchises || []).map(f => f.name).join('/') || '-'} ` +
      `collections=${(g.collections || []).map(c => `${c.name}${c.type ? ':' + c.type.name : ''}`).join('/') || '-'}`);
    say(`  parent=${g.parent_game?.name ?? '-'} version_parent=${g.version_parent?.name ?? '-'} ports=${(g.ports || []).map(x => x.name).join('/') || '-'} ` +
      `remasters=${(g.remasters || []).map(x => x.name).join('/') || '-'} remakes=${(g.remakes || []).map(x => x.name).join('/') || '-'}`);
    say(`  critics=${g.aggregated_rating?.toFixed?.(1) ?? '-'} (${g.aggregated_rating_count ?? 0}) players=${g.rating?.toFixed?.(1) ?? '-'} (${g.rating_count ?? 0})`);
    for (const rd of (g.release_dates || []).filter(rd => /PlayStation|PS/.test(rd.platform?.abbreviation || rd.platform?.name || ''))) say(`  release ${rowLine(rd)}`);
    const ext = (g.external_games || []).map(e => `${e.external_game_source?.name ?? '?'}${e.platform ? '/' + e.platform.abbreviation : ''}`);
    say(`  external sources: ${[...new Set(ext)].join(', ') || '-'}`);
  }

  // Time to beat for the sample and related records.
  const allIds = [...games, ...related].map(g => g.id);
  const ttb = await q('game_time_to_beats', `fields game_id,hastily,normally,completely,count,updated_at; where game_id = (${allIds.join(',')}); limit 100;`, 'time_to_beat');
  const h = s => (s ? `${Math.round(s / 360) / 10} h` : '-');
  say('\n# time to beat (hastily / normally / completely, submissions)');
  for (const x of ttb) say(`  ${[...games, ...related].find(g => g.id === x.game_id)?.name}: ${h(x.hastily)} / ${h(x.normally)} / ${h(x.completely)} (${x.count ?? 0})`);

  // Call of Duty franchise membership: everything IGDB places in the franchise, and the series collections' membership types.
  const cod4 = games.find(g => g.slug === 'call-of-duty-4-modern-warfare');
  if (cod4?.franchise?.id || cod4?.franchises?.length) {
    const fid = cod4.franchise?.id ?? cod4.franchises[0].id;
    const members = await q('games', `fields id,name,slug,game_type.type,first_release_date,platforms.abbreviation,collections.name,parent_game.name,version_parent.name; ` +
      `where franchise = ${fid} | franchises = (${fid}); sort first_release_date asc; limit 500;`, 'cod_franchise_games');
    const byType = {};
    for (const m of members) (byType[m.game_type?.type ?? '?'] ||= []).push(m);
    say(`\n# Call of Duty franchise (id ${fid}): ${members.length} records`);
    for (const [type, list] of Object.entries(byType)) say(`  ${type}: ${list.length}`);
    const collIds = (cod4.collections || []).map(c => c.id);
    if (collIds.length) {
      const mem = await q('collection_memberships', `fields collection.name,game.name,game.first_release_date,type.name; where collection = (${collIds.join(',')}); limit 500;`, 'cod_collection_memberships');
      const t2 = {};
      for (const m of mem) (t2[`${m.collection?.name} · ${m.type?.name ?? 'no type'}`] ||= []).push(m.game?.name);
      say('# series collection memberships');
      for (const [k, list] of Object.entries(t2)) say(`  ${k}: ${list.length} (e.g. ${list.slice(0, 4).join('; ')})`);
    }
  }
} catch (e) {
  say(`ERROR: ${e.message}`);
  process.exitCode = 1;
} finally {
  say(`\nrequests: ${requests}; token: ${await revokeToken()}`);
  fs.writeFileSync(path.join(outDir, 'summary.txt'), summary.join('\n') + '\n');
}
