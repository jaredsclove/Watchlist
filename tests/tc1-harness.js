// TC1, the member's TMDB cache (db/tc1_tmdb_cache.sql), for the offline harness, written independently of the page's code so
// the tests can catch a page/database mismatch: public.tmdb_tv_cache and library_tmdb_cache_put / _purge with the database's
// rules (a row written only when the stored row still has the revision sent, 0 meaning "no row"; revisions from one counter,
// never reused; every row sent answered with what is stored now). Used by tests/app-harness.js in the current phase unless
// createApp({ tmdbCache: false }) models a database without it.

const clone = v => JSON.parse(JSON.stringify(v));
let revSeq = 1000; // one counter for every app in the process, like the database's sequence: a revision is never seen twice

function tc1Handlers({ store, DbError }) {
  let idSeq = 0;
  const newId = () => `7c000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;
  const invalid = () => { throw new DbError('22023', 'invalid_input: cache rows'); };
  const keyOf = r => `${r.kind}|${r.tmdb_id}|${r.season_number}`;
  const find = r => store.tmdb_tv_cache.find(x => keyOf(x) === keyOf(r));
  return {
    library_tmdb_cache_put({ p_rows: rows }) {
      if (!Array.isArray(rows) || rows.length > 100) invalid();
      for (const r of rows) {
        if (!r || typeof r !== 'object' || !['show', 'season'].includes(r.kind) || !Number.isInteger(r.tmdb_id) || r.tmdb_id <= 0
          || !Number.isInteger(r.season_number) || !Number.isInteger(r.base_rev) || r.base_rev < 0 || !r.data || typeof r.data !== 'object' || Array.isArray(r.data)
          || (r.kind === 'show' ? r.season_number !== -1 : (r.season_number < 0 || !Array.isArray(r.data.ids)))
          || Buffer.byteLength(JSON.stringify(r.data).replace(/([,:])/g, '$1 '), 'utf8') > 40000) invalid(); // (jsonb's text: a space after each , and :)
      }
      if (new Set(rows.map(keyOf)).size !== rows.length) invalid();
      const out = rows.map(r => {
        const had = find(r);
        let written = false;
        if (r.base_rev === 0 && !had) {
          store.tmdb_tv_cache.push({ id: newId(), kind: r.kind, tmdb_id: r.tmdb_id, season_number: r.season_number, data: clone(r.data), rev: ++revSeq, fetched_at: new Date().toISOString() });
          written = true;
        } else if (had && r.base_rev !== 0 && had.rev === r.base_rev) {
          Object.assign(had, { data: clone(r.data), rev: ++revSeq, fetched_at: new Date().toISOString() });
          written = true;
        }
        const now = find(r);
        return { kind: r.kind, tmdb_id: r.tmdb_id, season_number: r.season_number, written, rev: now ? now.rev : null, data: now ? clone(now.data) : null, fetched_at: now ? now.fetched_at : null };
      });
      return { rows: out };
    },
    library_tmdb_cache_purge() { const n = store.tmdb_tv_cache.length; store.tmdb_tv_cache = []; return { removed: n }; }
  };
}
// A cache row as the database would hold it (tests seed with these): fetched_at defaults to now.
function cacheRow(kind, tmdbId, seasonNumber, data, fetchedAt = new Date().toISOString()) {
  return { id: `7d000000-0000-4000-8000-${String(++revSeq).padStart(12, '0')}`, kind, tmdb_id: tmdbId, season_number: kind === 'show' ? -1 : seasonNumber, data, rev: ++revSeq, fetched_at: fetchedAt };
}
const seasonCache = (tmdbId, seasonNumber, ids, numbers, names, fetchedAt) => cacheRow('season', tmdbId, seasonNumber,
  { ids, numbers: numbers || ids.map((x, i) => i + 1), names: names || ids.map(() => ''), last: null }, fetchedAt);
const showCache = (tmdbId, a, c, f = null, fetchedAt) => cacheRow('show', tmdbId, -1, { a, c, f }, fetchedAt);

module.exports = { tc1Handlers, cacheRow, seasonCache, showCache };
