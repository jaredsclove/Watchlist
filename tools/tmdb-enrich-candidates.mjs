// Read-only TMDB identity review for the legacy (not TMDB-matched) shows of one
// built-in collection, for the identity-enrichment project (docs/HANDOFF.md §18).
// GET requests only, to Supabase (anon key from config.js) and TMDB; nothing is written.
//
//   node tools/tmdb-enrich-candidates.mjs <collection> [--out=file.json]
//   collection: disney | 90day | sheridan
//
// For each legacy show it prints the local seasons, every plausibly-titled TMDB
// candidate (search results, with details: first air date, seasons, networks,
// creators, US/GB alternative titles), and for each candidate a proposed season
// mapping with the grade tools/identity-audit.mjs would give each season. A season
// label that isn't exactly "Season N" is flagged and never mapped, and seasons TMDB
// doesn't list are flagged. This is input for the owner's decision: it never picks
// a match, and nothing here makes one "certain" by itself.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { gradeTv, localToday } from './identity-audit.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILTIN = ['disney', '90day', 'sheridan'];

function loadConfig() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'config.js'), 'utf8'), ctx);
  return vm.runInContext('({ SUPABASE_URL, SUPABASE_KEY, TMDB_TOKEN, TMDB_BASE })', ctx);
}

async function get(url, headers) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: 'GET', headers });
    if (res.ok) return res;
    if (attempt >= 4 || (res.status < 500 && res.status !== 429)) throw new Error(`GET ${url.split('?')[0]} failed: ${res.status}`);
    await new Promise(r => setTimeout(r, 1000 * attempt));
  }
}

async function fetchAll(cfg, table, filter) {
  const headers = { apikey: cfg.SUPABASE_KEY, Authorization: `Bearer ${cfg.SUPABASE_KEY}`, 'Range-Unit': 'items', Prefer: 'count=exact' };
  const rows = [];
  let total = null;
  while (total === null || rows.length < total) {
    const res = await get(`${cfg.SUPABASE_URL}/rest/v1/${table}?select=*&${filter}&order=id.asc`, { ...headers, Range: `${rows.length}-${rows.length + 499}` });
    const m = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
    if (!m) throw new Error(`${table}: missing Content-Range total`);
    total = Number(m[1]);
    const page = await res.json();
    if (!page.length && rows.length < total) throw new Error(`${table}: short read`);
    rows.push(...page);
  }
  return rows;
}

const norm = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const plainSeason = l => (/^Season [1-9][0-9]{0,3}$/.test(l || '') ? Number(l.slice(7)) : null);

async function main() {
  const collection = process.argv[2];
  const outArg = process.argv.find(a => a.startsWith('--out='));
  if (!BUILTIN.includes(collection)) { console.error('usage: node tools/tmdb-enrich-candidates.mjs <disney|90day|sheridan> [--out=file.json]'); process.exit(2); }
  const cfg = loadConfig();
  const today = localToday();
  const tmdbCache = new Map();
  const tmdb = p => { if (!tmdbCache.has(p)) tmdbCache.set(p, get(cfg.TMDB_BASE + p, { Authorization: `Bearer ${cfg.TMDB_TOKEN}` }).then(r => r.json())); return tmdbCache.get(p); };

  console.log('TMDB enrichment review — READ-ONLY: GET requests only; nothing is written.');
  console.log(`Supabase host: ${new URL(cfg.SUPABASE_URL).host}  collection: ${collection}  today: ${today}\n`);
  const shows = (await fetchAll(cfg, 'tv_shows', `collection=eq.${collection}`)).filter(s => s.tmdb_id == null)
    .sort((a, b) => a.title.localeCompare(b.title));
  const rows = await fetchAll(cfg, 'watchlist_items', `collection=eq.${collection}`);
  console.log(`legacy shows: ${shows.length}; rows in ${collection}: ${rows.length} (films are not shows and are not reviewed)\n`);

  const report = [];
  for (const s of shows) {
    const seasons = rows.filter(r => r.show_id === s.id).sort((a, b) => (a.date_sort || '').localeCompare(b.date_sort || ''));
    const seen = new Map();
    for (const q of new Set([s.title, s.title.replace(/:/g, ''), s.title.split(':')[0].trim()])) {
      const res = await tmdb(`/search/tv?query=${encodeURIComponent(q)}&include_adult=false`);
      for (const x of (res.results || []).slice(0, 10)) if (!seen.has(x.id)) seen.set(x.id, x);
    }
    const lt = norm(s.title);
    const candidates = [];
    for (const x of seen.values()) {
      const nt = norm(x.name), no = norm(x.original_name);
      if (!(nt === lt || no === lt || (nt && lt.includes(nt)) || (lt && nt.includes(lt)))) continue;
      const d = await tmdb(`/tv/${x.id}?append_to_response=alternative_titles`);
      const alts = (d.alternative_titles?.results || []).filter(t => ['US', 'GB'].includes(t.iso_3166_1)).map(t => t.title);
      const listed = new Set((d.seasons || []).map(z => z.season_number));
      const mapping = seasons.map(r => {
        const n = plainSeason(r.season);
        if (n == null) return { season: r.season, date: r.display_date, flag: 'label is not exactly "Season N": needs the owner\'s decision; never forced' };
        const g = gradeTv({ ...r, media_type: 'tv', tmdb_id: d.id, season_number: n }, d, today);
        return { season: r.season, date: r.display_date, season_number: n, on_tmdb: listed.has(n), grade: g.grade, findings: g.findings.map(f => f[1]) };
      });
      candidates.push({ id: d.id, name: d.name, original_name: d.original_name, first_air: d.first_air_date, status: d.status,
        countries: d.origin_country, networks: (d.networks || []).map(n => n.name), creators: (d.created_by || []).map(p => p.name),
        n_seasons: d.number_of_seasons, alt_titles_us_gb: alts, exact_title: nt === lt || no === lt,
        tmdb_seasons: (d.seasons || []).map(z => ({ n: z.season_number, name: z.name, air: z.air_date, eps: z.episode_count })), mapping });
    }
    report.push({ title: s.title, show_id: s.id, status: s.status,
      seasons: seasons.map(r => ({ row_id: r.id, season: r.season, date: r.display_date, item_key: r.item_key })),
      other_results: seen.size - candidates.length, candidates });

    console.log(`## ${s.title} [${s.status}] — ${seasons.length} season${seasons.length === 1 ? '' : 's'}: ${seasons.map(r => `${r.season} (${r.display_date})`).join('; ')}`);
    if (!candidates.length) console.log('   no plausibly-titled TMDB candidate');
    for (const c of candidates) {
      console.log(`   ${c.exact_title ? '=' : '~'} ${c.id} "${c.name}"${c.original_name !== c.name ? ` (orig "${c.original_name}")` : ''} · first ${c.first_air || '—'} · ${c.n_seasons} seasons · ${c.status} · ${c.networks.join('/') || '—'} · ${(c.countries || []).join('/') || '—'} · by ${c.creators.join(', ') || '—'}${c.alt_titles_us_gb.length ? ` · US/GB alt: ${c.alt_titles_us_gb.join(' / ')}` : ''}`);
      console.log(`       TMDB seasons: ${c.tmdb_seasons.map(z => `${z.n}:${z.name}${z.air ? '@' + z.air : ''}(${z.eps})`).join(' | ') || 'none'}`);
      for (const m of c.mapping) console.log(`       ${m.season} → ${m.flag ? `⚠ ${m.flag}` : `${m.season_number} ${m.on_tmdb ? '' : '(NOT on TMDB) '}— audit ${m.grade}${m.findings.length ? ': ' + m.findings.join('; ') : ''}`}`);
    }
    console.log(`   (${report.at(-1).other_results} other search results with unrelated titles)\n`);
  }
  if (outArg) { fs.writeFileSync(outArg.slice(6), JSON.stringify(report, null, 1)); console.log(`wrote ${outArg.slice(6)}`); }
  console.log('Proposals only. Classify each show (Certain / Ambiguous — needs the owner / No clean match) and get the owner\'s decision before any write.');
}

main().catch(e => { console.error(`REVIEW ABORTED (no result): ${e.message}`); process.exit(2); });
