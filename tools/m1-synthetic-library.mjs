// A synthetic library as a format-5 backup, for hosted test environments (plan §8: synthetic data
// only). Every record is invented ("ZZ Synthetic …", made-up TMDB ids); it is built and exported by the
// page's own code in the offline harness, so it is exactly what the page would back up and restore.
//   node tools/m1-synthetic-library.mjs --seed <1-9> --out <file.json>
// Different seeds give disjoint ids and TMDB ids (one library per test user).
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createApp } = require('../tests/app-harness.js');

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const seed = Number(opt('--seed') || 1), out = opt('--out');
if (!out || !(seed >= 1 && seed <= 9)) { console.error('usage: node tools/m1-synthetic-library.mjs --seed <1-9> --out <file.json>'); process.exit(2); }

const id = n => `5${seed}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tmdb = n => 9000000 + seed * 10000 + n;
const ts = '2026-10-01T00:00:00+00:00';
const shows = [], rows = [];
const catalogs = ['disney', 'othertv', 'sheridan', 'othertv', 'othertv', '90day'];
for (let s = 1; s <= 6; s++) {
  const coll = catalogs[s - 1];
  shows.push({ id: id(1000 + s), collection: coll, title: `ZZ Synthetic Show ${seed}.${s}`, show_key: `zz synthetic show ${seed}.${s}`,
    tmdb_id: tmdb(s), status: s % 2 ? 'watching' : 'confirmed', created_at: ts });
  for (let n = 1; n <= 3; n++) {
    rows.push({ id: id(2000 + s * 10 + n), collection: coll, item_key: `zz synthetic show ${seed}.${s}|season ${n}`, title: `ZZ Synthetic Show ${seed}.${s}`,
      season: `Season ${n}`, theme: 'Synthetic', display_date: `Jan ${n}, 2025`, date_sort: `2025-01-0${n}`, watched: n === 1, status: 'confirmed',
      created_at: ts, watch_with: n === 1 ? ['Alone'] : [], collections: [], tmdb_collection_id: null, tmdb_collection_name: null,
      media_type: 'tv', tmdb_id: tmdb(s), season_number: n, show_id: id(1000 + s), skipped: false });
  }
}
for (let f = 1; f <= 4; f++) {
  rows.push({ id: id(3000 + f), collection: 'movies', item_key: `zz synthetic film ${seed}.${f}`, title: `ZZ Synthetic Film ${seed}.${f}`, season: 'Film',
    theme: 'Drama', display_date: 'Mar 1, 2024', date_sort: '2024-03-01', watched: f === 1, status: 'confirmed', created_at: ts, watch_with: [],
    collections: [], tmdb_collection_id: null, tmdb_collection_name: null, media_type: 'movie', tmdb_id: tmdb(100 + f), season_number: null, skipped: false });
}
const app = await createApp({ rows, tvShows: shows,
  personalCollections: [1, 2].map(c => ({ id: id(4000 + c), name: `ZZ Synthetic Collection ${seed}.${c}`, legacy_source: null, sort_order: c, archived_at: null, created_at: ts })),
  memberships: [{ id: id(5001), collection_id: id(4001), show_id: id(1001), item_id: null, created_at: ts },
    { id: id(5002), collection_id: id(4001), show_id: null, item_id: id(3001), created_at: ts }] });
// Ids the harness made (catalog links, watch-with choices) get a seed-specific prefix too, so two
// seeds share no id (ids are global keys, even across libraries).
const prefixes = new Map();
const own = new RegExp(`^5${seed}`);
const doc = JSON.parse(JSON.stringify(await app.run('buildBackupObject()')), (k, v) => {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) || own.test(v)) return v;
  const p = v.slice(0, 2);
  if (!prefixes.has(p)) prefixes.set(p, `${'6789abcdef'[prefixes.size]}${seed}`);
  return prefixes.get(p) + v.slice(2);
});
const errors = Array.from(app.get('validateBackupObject')(doc));
if (errors.length) { console.error(`invalid: ${errors.join('; ')}`); process.exit(1); }
fs.writeFileSync(out, JSON.stringify(doc));
console.log(`synthetic library (seed ${seed}): ${JSON.stringify(Object.fromEntries(Object.entries(doc.tables).map(([t, r]) => [t, r.length])))}`);
