// API-level rehearsal against the TEMPORARY Supabase test project, through the
// real PostgREST endpoint with the project's publishable key (the anon role),
// exactly as the browser app calls it. Refuses to run against production.
//
//   TEST_SUPABASE_URL=https://<test-ref>.supabase.co TEST_SUPABASE_KEY=sb_publishable_... \
//     node tools/db-rehearsal-rest.mjs <command> [backup.json]
// Commands:
//   load <backup.json>   restore the backup via rpc/restore_backup (any format the stage accepts)
//   direct-writes        replay every direct insert/update shape the app sends, then delete those rows
//   race                 two concurrent add_tv_seasons calls for the same new seasons
//   restore-roundtrip    build a v2 backup over the API, restore it, compare every row
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.env.TEST_SUPABASE_URL;
const KEY = process.env.TEST_SUPABASE_KEY;
const PROD = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8').match(/SUPABASE_URL = '([^']+)'/)[1];
if (!URL_ || !KEY) { console.error('set TEST_SUPABASE_URL and TEST_SUPABASE_KEY'); process.exit(2); }
if (URL_.replace(/\/$/, '') === PROD.replace(/\/$/, '')) { console.error('REFUSING: that is the production project'); process.exit(2); }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function api(method, p, body, extra = {}) {
  const res = await fetch(`${URL_}/rest/v1/${p}`, { method, headers: { ...H, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, ok: res.ok, json, headers: res.headers };
}
const must = (r, what) => { if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json)}`); return r.json; };
const ok = m => console.log(`  ok   ${m}`);
let failed = 0;
const check = async (name, fn) => { try { await fn(); ok(name); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

async function getAll(table, select = '*') {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const r = await api('GET', `${table}?select=${select}&order=id.asc`, undefined, { Range: `${from}-${from + 499}`, 'Range-Unit': 'items', Prefer: 'count=exact' });
    const page = must(r, `GET ${table}`);
    rows.push(...page);
    const total = Number((r.headers.get('content-range') || '').split('/')[1]);
    if (rows.length >= total || page.length === 0) break;
  }
  return rows;
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'load') {
  const backup = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const t0 = Date.now();
  const r = await api('POST', 'rpc/restore_backup', { p_backup: backup });
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} restore_backup over the API as anon (${JSON.stringify(backup).length} bytes, ${Date.now() - t0} ms): HTTP ${r.status} ${JSON.stringify(r.json)}`);
  if (!r.ok) failed++;
}

if (cmd === 'direct-writes') {
  // Every direct write shape the app sends today (see db/test/t_1b_ownership.sql),
  // through PostgREST with return=representation, then cleaned up by id.
  const ids = { watchlist_items: [], othertv_shows: [], custom_collections: [] };
  const rep = { Prefer: 'return=representation' };
  const owners = new Set();
  const insert = async (table, rows, what) => {
    const out = must(await api('POST', table, rows, rep), what);
    out.forEach(r => { ids[table].push(r.id); owners.add(r.user_id); });
    return out;
  };
  try {
    await check('movie manual add (addEntry on Movies)', () => insert('watchlist_items', [{ collection: 'movies', item_key: 'zz rest manual|film', title: 'ZZ Rest Manual', season: 'Film', theme: 'Drama', display_date: 'Jan 1, 2026', date_sort: '2026-01-01', watched: false, status: 'confirmed' }], 'manual add'));
    await check('movie TMDB add / collection, universe and person pulls (batch)', () => insert('watchlist_items', [
      { collection: 'movies', item_key: 'zz rest pull|film', title: 'ZZ Rest Pull', season: 'Film', theme: 'Action', display_date: 'Jan 1, 2026', date_sort: '2026-01-01', watched: false, status: 'confirmed', tmdb_collection_id: 9990001, tmdb_collection_name: 'ZZ Collection', collections: ['ZZ Collection', 'ZZ Person'], media_type: 'movie', tmdb_id: 999100001, season_number: null },
      { collection: 'movies', item_key: 'zz rest pull 2|film', title: 'ZZ Rest Pull 2', season: 'Film', theme: 'Action', display_date: 'TBA', date_sort: '2099-01-01', watched: false, status: 'confirmed', tmdb_collection_id: null, tmdb_collection_name: null, collections: ['MCU'], media_type: 'movie', tmdb_id: 999100002, season_number: null }], 'movie pulls'));
    await check('TV season add (search / Refresh shows) + othertv_shows registration', async () => {
      await insert('watchlist_items', [{ collection: 'othertv', item_key: 'zz rest show|season 1', title: 'ZZ Rest Show', season: 'Season 1', theme: 'HBO', display_date: 'TBA', date_sort: '2099-01-01', watched: false, status: 'confirmed', media_type: 'tv', tmdb_id: 999100003, season_number: 1 }], 'tv add');
      await insert('othertv_shows', [{ tmdb_id: 999100003, title: 'ZZ Rest Show', network: 'HBO', collection: 'othertv' }], 'tracked show');
    });
    await check('built-in DEFAULT seeding: TV season + film rows (loadTab)', () => insert('watchlist_items', [
      { collection: 'disney', item_key: 'zz rest default|season 1', title: 'ZZ Rest Default', season: 'Season 1', theme: 'Star Wars', display_date: 'TBA 2027', date_sort: '2027-06-01', watched: false, status: 'pending' },
      { collection: 'sheridan', item_key: 'zz rest default film|film', title: 'ZZ Rest Default Film', season: 'Film', theme: 'Western', display_date: 'Jan 1, 2027', date_sort: '2027-01-01', watched: false, status: 'confirmed' }], 'seeding'));
    await check('person collection creation (custom_collections)', () => insert('custom_collections', [{ name: 'ZZ Rest Person', tmdb_person_id: 999100004, role: 'director' }], 'person'));
    await check('every PATCH shape (status, watched, watch_with, collections, dates, Match patch)', async () => {
      const [row] = await insert('watchlist_items', [{ collection: 'othertv', item_key: 'zz rest manual show|season 1', title: 'ZZ Rest Manual Show', season: 'Season 1', theme: 'HBO', display_date: 'TBA', date_sort: '2099-01-01', watched: false, status: 'confirmed' }], 'manual tv');
      for (const body of [{ status: 'watching' }, { watched: true }, { watch_with: ['Alone'] }, { collections: ['ZZ Tag'] }, { display_date: 'Jan 1, 2027', date_sort: '2027-01-01' }]) {
        must(await api('PATCH', `watchlist_items?id=eq.${row.id}`, body, { Prefer: 'return=minimal' }), `PATCH ${Object.keys(body)}`);
      }
      must(await api('PATCH', `watchlist_items?id=eq.${row.id}&tmdb_id=is.null&media_type=is.null&season_number=is.null`,
        { title: 'ZZ Rest Matched', season: 'Season 1', item_key: 'zz rest matched|season 1', theme: 'HBO', display_date: 'Jan 1, 2027', date_sort: '2027-01-01', media_type: 'tv', tmdb_id: 999100005, season_number: 1 },
        { Prefer: 'return=minimal' }), 'Match patch');
    });
    await check('API refuses an explicit user_id on insert, and any change to user_id', async () => {
      const a = await api('POST', 'watchlist_items', [{ collection: 'movies', item_key: 'zz rest owner|film', title: 'ZZ', user_id: '00000000-0000-4000-8000-000000000001' }], rep);
      if (a.ok) { ids.watchlist_items.push(a.json[0].id); throw new Error('insert with user_id accepted'); }
      if (a.json?.code !== '42501') throw new Error(`unexpected ${a.status} ${JSON.stringify(a.json)}`);
      const b = await api('PATCH', `watchlist_items?id=eq.${ids.watchlist_items[0]}`, { user_id: '00000000-0000-4000-8000-000000000001' }, { Prefer: 'return=minimal' });
      if (b.ok || b.json?.code !== '42501') throw new Error(`user_id change: ${b.status} ${JSON.stringify(b.json)}`);
    });
    await check('every inserted row got the one bootstrap owner (user_id visible in reads, as decided)', async () => {
      if (owners.size !== 1 || [...owners][0] == null) throw new Error(`owners ${[...owners]}`);
      const existing = await getAll('watchlist_items', 'user_id');
      if (new Set(existing.map(r => r.user_id)).size !== 1 || existing[0].user_id !== [...owners][0]) throw new Error('mixed owners');
    });
  } finally {
    for (const [t, list] of Object.entries(ids)) {
      for (const id of list) must(await api('DELETE', `${t}?id=eq.${id}`, undefined, { Prefer: 'return=minimal' }), `cleanup ${t}`);
    }
    ok(`cleaned up ${Object.values(ids).flat().length} test rows by id`);
  }
}

if (cmd === 'race') {
  // Two browsers add the same new seasons at the same moment: both succeed, each
  // season exists once, and the second call reports them as existing.
  const show = { tmdb_id: 999200001, title: 'ZZ Race', show_key: 'zz race' };
  const seasons = [1, 2, 3].map(n => ({ item_key: `zz race|season ${n}`, title: 'ZZ Race', season: `Season ${n}`, date_sort: '2020-01-01', season_number: n }));
  const calls = await Promise.all([0, 1, 2, 3].map(() => api('POST', 'rpc/add_tv_seasons', { p_collection: 'othertv', p_show: show, p_seasons: seasons })));
  await check('4 concurrent add_tv_seasons calls for the same seasons all succeed', () => {
    const bad = calls.filter(c => !c.ok); if (bad.length) throw new Error(JSON.stringify(bad.map(b => b.json)));
  });
  await check('each season inserted exactly once; every other call saw them as existing; one show', async () => {
    const inserted = calls.reduce((n, c) => n + c.json.inserted.length, 0);
    const existing = calls.reduce((n, c) => n + c.json.existing.length, 0);
    if (inserted !== 3 || existing !== 9) throw new Error(`inserted ${inserted} existing ${existing}`);
    if (new Set(calls.map(c => c.json.show_id)).size !== 1) throw new Error('more than one show');
    if (calls.filter(c => c.json.show_created).length !== 1) throw new Error('show created more than once');
  });
  const rows = must(await api('GET', 'watchlist_items?select=id&tmdb_id=eq.999200001'), 'rows');
  for (const r of rows) must(await api('POST', 'rpc/delete_tv_season', { p_row_id: r.id }), 'cleanup');
  ok(`cleaned up ${rows.length} rows (last delete removed the show)`);
}

if (cmd === 'restore-roundtrip') {
  const tables = ['watchlist_items', 'tv_shows', 'othertv_shows', 'custom_collections'];
  const strip = r => { const { user_id, ...rest } = r; return rest; };
  const data = {};
  for (const t of tables) data[t] = (await getAll(t)).map(strip);
  const backup = { format: 'watchlist-tracker-backup', formatVersion: 2, exportedAt: new Date().toISOString(),
    rowCounts: Object.fromEntries(tables.map(t => [t, data[t].length])), tables: data };
  const t0 = Date.now();
  const r = await api('POST', 'rpc/restore_backup', { p_backup: backup });
  await check(`v2 restore over the API (${JSON.stringify(backup).length} bytes, ${Date.now() - t0} ms)`, () => { if (!r.ok) throw new Error(JSON.stringify(r.json)); });
  await check('every row reads back identical after the round trip', async () => {
    for (const t of tables) {
      const after = (await getAll(t)).map(strip);
      if (JSON.stringify(after) !== JSON.stringify(data[t])) throw new Error(`${t} differs`);
    }
  });
}

// ── End-to-end (run with the SQL steps in between; see db/README.md) ────────
const STATE = process.env.E2E_STATE_FILE || '/tmp/watchlist-e2e-statuses.json';
async function showsWithSeasons() {
  const shows = await getAll('tv_shows', 'id,status,title');
  const rows = await getAll('watchlist_items');
  const by = new Map(shows.map(s => [s.id, { show: s, seasons: [] }]));
  for (const r of rows) if (r.show_id) by.get(r.show_id).seasons.push(r);
  return by;
}
const rpcCall = async (fn, args) => must(await api('POST', `rpc/${fn}`, args), fn);

if (cmd === 'e2e-shadow') {
  await check('shadow: function add of a new show; old-style season PATCH (the Phase 2 app)', async () => {
    await rpcCall('add_tv_seasons', { p_collection: 'othertv', p_show: { tmdb_id: 999300001, title: 'ZZ E2E', show_key: 'zz e2e' },
      p_seasons: [1, 2].map(n => ({ item_key: `zz e2e|season ${n}`, title: 'ZZ E2E', season: `Season ${n}`, date_sort: '2020-01-01', season_number: n })) });
    must(await api('PATCH', 'watchlist_items?item_key=eq.zz%20e2e%7Cseason%201', { status: 'watching' }, { Prefer: 'return=minimal' }), 'PATCH');
  });
}

if (cmd === 'e2e-authoritative') {
  const { createRequire } = await import('module');
  const M = createRequire(import.meta.url)(path.join(ROOT, 'tests/tv-model-reference.js'));
  await check('authoritative edits through the functions as anon (status, watched, skip, reopen, last-season delete)', async () => {
    const [tr] = must(await api('GET', 'tv_shows?select=id&title=eq.The%20Traitors'), 'traitors');
    await rpcCall('set_show_status', { p_show_id: tr.id, p_status: 'complete' });
    await rpcCall('set_show_status', { p_show_id: tr.id, p_status: 'watching' });
    const [s5] = must(await api('GET', `watchlist_items?select=id&show_id=eq.${tr.id}&season_number=eq.5`), 's5');
    await rpcCall('set_season_watched', { p_row_id: s5.id, p_watched: true });
    const [s1] = must(await api('GET', `watchlist_items?select=id&show_id=eq.${tr.id}&season_number=eq.1`), 's1');
    await rpcCall('set_season_skipped', { p_row_id: s1.id, p_skipped: true });
    const [bb] = must(await api('GET', 'tv_shows?select=id,tmdb_id&title=eq.Breaking%20Bad'), 'bb');
    const r = await rpcCall('add_tv_seasons', { p_collection: 'othertv', p_show: { tmdb_id: bb.tmdb_id, title: 'Breaking Bad', show_key: 'breaking bad' },
      p_seasons: [{ item_key: 'breaking bad|season 6', title: 'Breaking Bad', season: 'Season 6', date_sort: '2030-01-01', season_number: 6 }] });
    if (!r.reopened) throw new Error('Breaking Bad not reopened');
    for (const x of must(await api('GET', 'watchlist_items?select=id&item_key=like.zz%20e2e*'), 'e2e')) await rpcCall('delete_tv_season', { p_row_id: x.id });
    if (must(await api('GET', 'tv_shows?select=id&show_key=eq.zz%20e2e'), 'e2e show').length) throw new Error('empty show kept');
    if (must(await api('GET', 'othertv_shows?select=id&tmdb_id=eq.999300001'), 'tracked').length) throw new Error('tracked entry kept');
  });
  await check('old app would derive the same show status and up next from the compatibility values, for every show', async () => {
    const by = await showsWithSeasons();
    for (const { show, seasons } of by.values()) {
      if (M.oldAggregateStatus(seasons) !== show.status) throw new Error(`aggregate differs: ${show.title}`);
      if (show.status === 'watching' && !seasons.every(s => s.skipped)) {
        const a = M.oldUpNext(seasons), b = M.upNext(seasons);
        if ((a ? a.id : null) !== (b ? b.id : null)) throw new Error(`up next differs: ${show.title}`);
      }
    }
    fs.writeFileSync(STATE, JSON.stringify([...by.values()].map(x => [x.show.id, x.show.status]).sort()));
    ok(`checked ${by.size} shows; statuses saved for the rollback comparison`);
  });
}

if (cmd === 'e2e-after-rollback3') {
  await check('after rolling back the switch-over (stage shadow + resync) every show status is unchanged', async () => {
    const before = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const after = (await getAll('tv_shows', 'id,status')).map(s => [s.id, s.status]).sort();
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('statuses differ');
  });
}

console.log(failed ? `REST REHEARSAL FAILED (${failed})` : 'REST REHEARSAL PASSED');
process.exitCode = failed ? 1 : 0;
