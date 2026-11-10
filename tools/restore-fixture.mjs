// Shared by the local restore tests: the migration replay, the page's own backup code, and a synthetic library with rows in all
// nineteen tables of a format-7 backup (library8: all twenty-one of format 8). Every record is invented ("ZZ …", made-up TMDB ids).
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const A = '00000000-0000-4000-8000-00000000000a'; // a member with research access
export const B = '00000000-0000-4000-8000-00000000000b'; // a member without it
export const C = '00000000-0000-4000-8000-00000000000c'; // signed in, not a member
export const file = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Rebuilds the database in order, as db/README.md lists it, through `exec(sql)`. W1 and its removal are left out: the removal's own test
// showed the catalog afterwards equals the one before W1, and no later migration depends on them.
export async function replay(exec, { through = 'final' } = {}) {
  const run = (key, f, extra = '') => exec(`select set_config('watchlist.${key}_run', 'local-${key}', false)${extra};\n` + file(f));
  for (const f of ['db/test/supabase_shim.sql', 'db/test/replica_schema.sql', 'db/phase0_restore_v1.sql']) await exec(file(f));
  await exec(`set timezone = 'UTC'`);
  for (const f of ['db/phase1b_ownership.sql', 'db/restore_backup.sql', 'db/phase1c_tv_schema.sql', 'db/tv_model.sql', 'db/rpc.sql', 'db/admin/tv_enrich.sql']) await exec(file(f));
  await exec(`update private.migration_stage set stage = 'final'`);
  for (const f of ['db/phase3b_org.sql', 'db/phase3b2_org_write.sql', 'db/phase4a_catalog.sql', 'db/phase4b_add_to_show.sql', 'db/phase5a_expand.sql', 'db/phase5c_contract.sql']) await exec(file(f));
  await exec(`select set_config('watchlist.b45_choices', '{"shows": {}, "films": {}}', false);\n` + file('db/b45_expand.sql'));
  await exec(`insert into auth.users (id, email) values ('${A}', 'a@test.invalid'), ('${B}', 'b@test.invalid'), ('${C}', 'c@test.invalid');
    begin; select set_config('watchlist.library_write', 'on', true);
    insert into private.stage5_recovery_meta (user_id, origin, counts, hashes) select bootstrap_owner_id, 'contraction', '{}'::jsonb, '{}'::jsonb from private.app_owner; commit;`);
  await exec(`select set_config('watchlist.m1_owner', '${A}', false), set_config('watchlist.m1_run', 'local-m1', false);\n` + file('db/m1_access.sql'));
  await run('ep1', 'db/ep1_episode_marks.sql');
  await run('enrich', 'db/admin/tv_enrich_partial.sql');
  await run('cu1', 'db/cu1_collection_updates.sql');
  await run('cu1b', 'db/cu1b_hold_edit.sql');
  await run('cu1c', 'db/cu1c_date_equivalence.sql');
  await run('cu1d', 'db/cu1d_network_and_marks.sql');
  await run('cu2', 'db/cu2_research_access.sql', `, set_config('watchlist.cu2_owner', '${A}', false)`);
  await run('cu1e', 'db/cu1e_missing_season.sql');
  await exec(`insert into private.library_members (user_id, note) values ('${B}', 'local B')`);
}

// The page's own code, loaded as the admin tool loads it: P('validateBackupObject')(doc).
export function pageCode() {
  const page = { console, Map, Set, JSON, Date, Math, Array, Object, String, Number, Boolean, RegExp, Error, Promise, parseInt, isFinite,
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {} }, window: {}, localStorage: { getItem: () => null, setItem() {} },
    crypto: crypto.webcrypto, TextEncoder };
  page.window = page;
  vm.createContext(page);
  for (const f of ['config.js', 'ui-helpers.js', 'metadata.js', 'api.js', 'backup-restore.js', 'collection-updates.js']) vm.runInContext(file(f), page, { filename: f });
  return expr => vm.runInContext(expr, page);
}

const md5 = t => crypto.createHash('md5').update(t).digest('hex');
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const ts = (n, s = 0) => `2026-${String(1 + (n % 9)).padStart(2, '0')}-1${n % 10}T0${n % 10}:00:${String(s % 60).padStart(2, '0')}.123456+00:00`;
const SPEC_CU1 = ['update_setup', 'collection_definitions', 'collection_exclusions', 'update_holds', 'record_aliases', 'membership_removals',
  'show_update_settings', 'research_briefs', 'research_imports', 'update_findings'];

// A valid format-7 library. seed: 1–9, disjoint ids and TMDB ids per seed. scale: shows, each with four seasons and marks; 1 is enough for
// behaviour, a larger one measures timing. The rows cover what the tables allow: custom collections, film links, an active Earlier seasons range,
// an archived collection and choice, the retired New from catalog and Needs status review flags, holds, research data.
export function library(seed = 1, scale = 8) {
  const id = n => `7${seed}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const tmdb = n => 8000000 + seed * 100000 + n;
  const t = Object.fromEntries(['watch_with_choices', 'personal_collections', 'tv_shows', 'watchlist_items', 'custom_collections', 'collection_memberships',
    'catalog_show_links', 'catalog_film_links', 'episode_marks', ...SPEC_CU1].map(k => [k, []]));
  t.watch_with_choices.push({ id: id(1), token: 'alone', label: 'Alone', sort_order: 1, archived_at: null, created_at: ts(1) },
    { id: id(2), token: 'zzold', label: 'ZZ Old Choice', sort_order: 2, archived_at: ts(2), created_at: ts(2) });
  t.personal_collections.push({ id: id(11), name: 'ZZ Catalog', catalog_id: 'disney', presentation_key: 'disney', sort_order: 1, archived_at: null, created_at: ts(3) },
    { id: id(12), name: 'ZZ Mine', catalog_id: null, presentation_key: null, sort_order: 2, archived_at: null, created_at: ts(4) },
    { id: id(13), name: 'ZZ Archived', catalog_id: null, presentation_key: 'truecrime', sort_order: 3, archived_at: ts(5), created_at: ts(5) });
  const season = (s, sid, n, extra = {}) => ({ id: id(sid), item_key: `zz show ${seed} ${s}|season ${n}`, title: `ZZ Show ${seed}.${s}`, season: `Season ${n}`, theme: 'ZZ Theme', theme_kind: null,
    display_date: `Jan ${n}, 2025`, date_sort: `2025-01-0${n}`, watched: n === 1, status: 'confirmed', created_at: ts(s, n), watch_with: n === 1 ? ['alone'] : [], collections: [],
    tmdb_collection_id: null, tmdb_collection_name: null, media_type: 'tv', tmdb_id: tmdb(s), season_number: n, show_id: id(1000 + s), skipped: false,
    priority: null, catalog_new: null, status_review: null, legacy_status: null, genres: null, forms: null, franchises: null, companies: null, genre_candidates: null, metadata_owner_set: null, ...extra });
  for (let s = 1; s <= scale; s++) {
    t.tv_shows.push({ id: id(1000 + s), title: `ZZ Show ${seed}.${s}`, show_key: `zz show ${seed} ${s}`, tmdb_id: tmdb(s), status: ['confirmed', 'watching', 'skipped'][s % 3], created_at: ts(s),
      priority: ['normal', 'high', 'low'][s % 3], ended: s % 4 === 0, catalog_new: s % 5 === 2, status_review: s % 5 === 3, legacy_status: s % 5 === 2 ? 'pending' : s % 5 === 3 ? 'complete' : null,
      genres: s % 2 ? ['Drama'] : [], forms: [], franchises: s % 3 ? [] : ['ZZ Universe'], companies: [], genre_candidates: s % 2 ? [] : ['Comedy', 'Crime'], network: s % 2 ? 'ZZ Net' : null, network_candidates: s % 2 ? ['ZZ Net'] : ['ZZ Net', 'ZZ Other'],
      metadata_owner_set: s % 2 === 0, resume_start_season_id: s % 3 === 1 ? id(10000000 + (s * 10) + 1) : null, resume_end_season_id: s % 3 === 1 ? id(10000000 + (s * 10) + 3) : null });
    for (let n = 1; n <= 4; n++) t.watchlist_items.push(season(s, 10000000 + s * 10 + n, n, n === 4 ? { display_date: 'TBA', date_sort: '9999-12-31', watched: false } : {}));
    for (let e = 1; e <= 3; e++) t.episode_marks.push({ id: id(500000 + s * 10 + e), season_id: id(10000000 + s * 10 + 2), tmdb_episode_id: tmdb(1000 + s * 10 + e), episode_number: e });
    t.collection_memberships.push({ id: id(600000 + s), collection_id: id(12), show_id: id(1000 + s), item_id: null, created_at: ts(s) });
  }
  // An unmatched show with an unmatched season.
  t.tv_shows.push({ id: id(999), title: 'ZZ Unmatched', show_key: 'zz unmatched', tmdb_id: null, status: 'confirmed', created_at: ts(6), priority: 'normal', ended: false, catalog_new: false, status_review: false,
    legacy_status: null, genres: [], forms: [], franchises: [], companies: [], genre_candidates: [], network: null, network_candidates: [], metadata_owner_set: false, resume_start_season_id: null, resume_end_season_id: null });
  t.watchlist_items.push(season(0, 998, 1, { item_key: 'zz unmatched|season 1', title: 'ZZ Unmatched', media_type: null, tmdb_id: null, season_number: null, show_id: id(999), watch_with: [], watched: false }));
  // Films: a genre film, a catalog-governed one, a Skipped + Watched pair with retired flags, and one with an archived choice.
  const film = (n, extra = {}) => ({ id: id(3000 + n), item_key: `zz film ${seed} ${n}`, title: `ZZ Film ${seed}.${n}`, season: 'Film', theme: 'Drama', theme_kind: 'genre', display_date: 'Mar 1, 2024', date_sort: '2024-03-01',
    watched: false, status: 'confirmed', created_at: ts(n), watch_with: [], collections: [], tmdb_collection_id: 9000 + seed, tmdb_collection_name: 'ZZ Saga', media_type: 'movie', tmdb_id: tmdb(500 + n), season_number: null, show_id: null, skipped: false,
    priority: 'normal', catalog_new: false, status_review: false, legacy_status: null, genres: ['Drama'], forms: [], franchises: [], companies: [], genre_candidates: [], metadata_owner_set: false, ...extra });
  t.watchlist_items.push(film(1), film(2, { theme_kind: 'other', theme: 'ZZ Catalog Theme', priority: 'high', tmdb_collection_id: null, tmdb_collection_name: null }),
    film(3, { status: 'skipped', watched: true, catalog_new: true, status_review: true, legacy_status: 'pending', metadata_owner_set: true }), film(4, { watch_with: ['alone', 'zzold'], watched: true }));
  t.custom_collections.push({ id: id(31), name: `ZZ Person ${seed}`, tmdb_person_id: 7000 + seed, created_at: ts(7), role: 'actor' }, { id: id(32), name: `ZZ Person ${seed} B`, tmdb_person_id: 7100 + seed, created_at: ts(8), role: null });
  t.collection_memberships.push({ id: id(41), collection_id: id(12), show_id: null, item_id: id(3001), created_at: ts(1) }, { id: id(42), collection_id: id(11), show_id: id(1001), item_id: null, created_at: ts(2) });
  t.catalog_show_links.push({ id: id(51), catalog: 'disney', catalog_key: `zz show ${seed} 1`, show_id: id(1001), origin: 'migrated_from_storage', created_at: ts(1) },
    { id: id(52), catalog: 'sheridan', catalog_key: `zz show ${seed} 2`, show_id: id(1002), origin: 'catalog_insert', created_at: ts(2) });
  t.catalog_film_links.push({ id: id(53), catalog: 'disney', entry_key: `zz film ${seed} 2`, item_id: id(3002), origin: 'migrated_from_storage', created_at: ts(3) });
  // jsonb's own text for these two values: the database compares its hashes with them.
  const rules = [{ id: 'r1', text: 'ZZ written rule', type: 'written' }];
  const evidence = { trades: [], standard: 'official_or_two_trades', official_domains: ['zz.example.com'] };
  t.update_setup.push({ id: id(61), setup_confirmed_at: ts(1), source: 'setup_file' });
  t.collection_definitions.push({ id: id(62), collection_id: id(12), version: 1, mode: 'manual', rules, evidence, summary: 'ZZ summary', rule_hashes: { r1: md5('{"id": "r1", "text": "ZZ written rule", "type": "written"}') },
    evidence_hash: md5('{"trades": [], "standard": "official_or_two_trades", "official_domains": ["zz.example.com"]}'), confirmed_at: ts(2) });
  t.collection_exclusions.push({ id: id(63), collection_id: id(12), kind: 'title', title: 'ZZ Excluded', match_text: 'zz excluded', tmdb_id: tmdb(900), media: 'tv', note: 'ZZ note', created_at: ts(3) });
  t.update_holds.push({ id: id(64), kind: 'protected_value', collection_id: id(12), show_id: id(1001), item_id: null, subject_label: null, field: 'display_date', protected_value: 'Jan 1, 2025', decision: 'ZZ keep', effect: 'keep_value', reopen: { on: 'owner_only' }, decided_on: '2026-01-02', created_at: ts(4) },
    { id: id(65), kind: 'standing_decision', collection_id: null, show_id: null, item_id: null, subject_label: 'ZZ Label', field: null, protected_value: null, decision: 'ZZ no', effect: 'do_not_add', reopen: { on: 'named_source', source_domains: ['zz.example.com'], source_name: 'ZZ' }, decided_on: null, created_at: ts(5) });
  t.record_aliases.push({ id: id(66), show_id: id(1002), item_id: null, alias: 'ZZ Alias', match_text: 'zz alias', evidence: [{ url: 'https://zz.example.com/a' }], created_at: ts(6) },
    { id: id(67), show_id: null, item_id: id(3001), alias: 'ZZ Film Alias', match_text: 'zz film alias', evidence: [], created_at: ts(7) });
  t.membership_removals.push({ id: id(68), collection_id: id(12), show_id: null, item_id: id(3002), removed_at: ts(8) });
  t.show_update_settings.push({ id: id(69), show_id: id(1003), follow_when_skipped: true, new_season_after_ended_at: ts(9), updated_at: ts(1) });
  t.research_briefs.push({ id: id(70), exported_at: ts(1), collections: [{ collection_id: id(12), name: 'ZZ Mine' }], checks: [{ show_id: id(1001) }] });
  t.research_imports.push({ id: id(71), brief_id: id(70), file_sha256: sha(`zz import ${seed}`), imported_at: ts(2), counts: { applied: 1 } });
  t.update_findings.push({ id: id(72), fingerprint: `new_season:${sha(`zz a ${seed}`)}`, source: 'tmdb', kind: 'new_season', status: 'applied', reason: '', collection_id: null, show_id: id(1001), item_id: null, season_id: id(10000011), subject: { season_number: 1 }, proposed: {}, expected: {}, evidence: [], assessment: {},
    rule_id: null, definition_version: null, rule_hash: null, evidence_hash: null, brief_id: null, first_seen_at: ts(1), last_seen_at: ts(2), decided_at: null, applied_at: ts(3), result: { outcome: 'applied' } },
    { id: id(73), fingerprint: `date:${sha(`zz b ${seed}`)}`, source: 'research', kind: 'date', status: 'needs_evidence', reason: 'evidence_insufficient', collection_id: id(12), show_id: id(1002), item_id: null, season_id: null, subject: { title: 'ZZ' }, proposed: { display_date: 'TBA' }, expected: { a: 1 }, evidence: [{ url: 'https://zz.example.com/b' }], assessment: { standard: 'official' },
      rule_id: 'r1', definition_version: 1, rule_hash: 'x', evidence_hash: 'y', brief_id: id(70), first_seen_at: ts(4), last_seen_at: ts(5), decided_at: ts(6), applied_at: null, result: null });
  return { format: 'watchlist-tracker-backup', formatVersion: 7, exportedAt: '2026-10-01T00:00:00.000Z',
    rowCounts: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.length])), tables: t };
}
// The same library at format 8 (Q1): two queues, in their saved order, holding a whole show, a season of another show and a film.
export const SPEC_Q1 = ['watch_queues', 'queue_entries'];
export function library8(seed = 1, scale = 8) {
  const d = library(seed, scale), id = n => `7${seed}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  d.formatVersion = 8;
  d.tables.watch_queues = [{ id: id(80001), name: `ZZ Queue ${seed}`, sort_order: 1, created_at: '2026-11-01T01:00:00.123456+00:00' },
    { id: id(80002), name: `ZZ Other Queue ${seed}`, sort_order: 2, created_at: '2026-11-01T02:00:00.123456+00:00' }];
  d.tables.queue_entries = [
    { id: id(80011), queue_id: id(80001), show_id: id(1001), item_id: null, position: 1, created_at: '2026-11-01T03:00:00.123456+00:00' },
    { id: id(80012), queue_id: id(80001), show_id: null, item_id: id(10000000 + 2 * 10 + 3), position: 2, created_at: '2026-11-01T04:00:00.123456+00:00' },
    { id: id(80013), queue_id: id(80001), show_id: null, item_id: id(3001), position: 4, created_at: '2026-11-01T05:00:00.123456+00:00' },
    { id: id(80014), queue_id: id(80002), show_id: null, item_id: id(3001), position: 1, created_at: '2026-11-01T06:00:00.123456+00:00' },
    { id: id(80015), queue_id: id(80002), show_id: null, item_id: id(10000000 + 1 * 10 + 1), position: 2, created_at: '2026-11-01T07:00:00.123456+00:00' }];
  d.rowCounts = Object.fromEntries(Object.entries(d.tables).map(([k, v]) => [k, v.length]));
  return d;
}
// The same library at format 9 (G1): platforms and play style, three saved game versions (an original Finished, its remaster with a
// joined port, another game), a followed franchise, one decision of each kind, a game collection with two members, and two games in
// the first queue between its other entries (places 3 and 5, as a hidden game keeps its place). Made-up IGDB ids.
export const SPEC_G1 = ['game_settings', 'game_entries', 'game_follows', 'game_decisions', 'game_collections', 'game_collection_members'];
export function library9(seed = 1, scale = 8) {
  const d = library8(seed, scale), id = n => `7${seed}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const ig = n => 9000000 + seed * 1000 + n, at = h => `2026-11-0${1 + (h % 8)}T1${h % 10}:00:00.123456+00:00`;
  const t = {};
  t.game_settings = [{ id: id(90001), platforms: ['ps5'], play_style: 'main_extra', updated_at: at(1) }];
  t.game_entries = [
    { id: id(90011), igdb_id: ig(1), spot_igdb_id: ig(1), port_ids: [], title: `ZZ Game ${seed} Original`, status: 'finished', priority: 'normal', created_at: at(2), updated_at: at(3) },
    { id: id(90012), igdb_id: ig(2), spot_igdb_id: ig(1), port_ids: [ig(3)], title: `ZZ Game ${seed} Remastered`, status: 'want', priority: 'high', created_at: at(4), updated_at: at(4) },
    { id: id(90013), igdb_id: ig(10), spot_igdb_id: ig(10), port_ids: [], title: `ZZ Game ${seed} Two`, status: 'playing', priority: 'low', created_at: at(5), updated_at: at(6) }];
  t.game_follows = [{ id: id(90021), igdb_collection_id: 7000 + seed, name: `ZZ Series ${seed}`, created_at: at(1) }];
  t.game_decisions = [
    { id: id(90031), kind: 'not_out_yet', igdb_id: ig(20), platform: 'ps5', value: { date: '2026-10-23', precision: 'day' }, basis: 'member', created_at: at(2) },
    { id: id(90032), kind: 'available', igdb_id: ig(21), platform: 'ps5', value: { precision: 'year', year: 2027, evidence: [{ url: 'https://zz.example.com/store' }] }, basis: 'research', created_at: at(3) },
    { id: id(90033), kind: 'skip_spot', igdb_id: ig(30), platform: '', value: {}, basis: 'member', created_at: at(4) },
    { id: id(90034), kind: 'include_spinoff', igdb_id: ig(31), platform: '', value: {}, basis: 'member', created_at: at(5) },
    { id: id(90035), kind: 'keep_link', igdb_id: ig(2), platform: '', value: { spot_igdb_id: ig(9), port_ids: [] }, basis: 'member', created_at: at(6) }];
  t.game_collections = [{ id: id(90041), name: `ZZ Couch Games ${seed}`, created_at: at(1) }];
  t.game_collection_members = [
    { id: id(90051), collection_id: id(90041), entry_id: id(90012), created_at: at(2) },
    { id: id(90052), collection_id: id(90041), entry_id: id(90013), created_at: at(3) }];
  const qe = d.tables.queue_entries.map(e => ({ id: e.id, queue_id: e.queue_id, show_id: e.show_id, item_id: e.item_id, game_entry_id: null, position: e.position, created_at: e.created_at }));
  qe.push({ id: id(90061), queue_id: id(80001), show_id: null, item_id: null, game_entry_id: id(90012), position: 3, created_at: at(7) },
    { id: id(90062), queue_id: id(80001), show_id: null, item_id: null, game_entry_id: id(90013), position: 5, created_at: at(7) });
  const tables = {};
  for (const [k, v] of Object.entries(d.tables)) { if (k === 'watch_queues') Object.assign(tables, t); tables[k] = v; }
  tables.queue_entries = qe;
  return { format: d.format, formatVersion: 9, exportedAt: d.exportedAt, rowCounts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), tables };
}
// A format-9 document as format 8: no game tables, queue entries without game_entry_id (and without the games in them).
export const as8 = d => {
  const x = JSON.parse(JSON.stringify(d));
  SPEC_G1.forEach(t => { delete x.tables[t]; delete x.rowCounts[t]; });
  x.tables.queue_entries = x.tables.queue_entries.filter(e => e.game_entry_id == null).map(({ game_entry_id, ...e }) => e);
  x.rowCounts.queue_entries = x.tables.queue_entries.length; x.formatVersion = 8; return x;
};
// A format-8 document as format 7: no queue tables.
export const as7 = d => { const x = JSON.parse(JSON.stringify(d)); SPEC_Q1.forEach(t => { delete x.tables[t]; delete x.rowCounts[t]; }); x.formatVersion = 7; return x; };
export const clone = d => JSON.parse(JSON.stringify(d));
// A file's table dropped or replaced, with rowCounts kept right.
export const recount = d => { d.rowCounts = Object.fromEntries(Object.entries(d.tables).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])); return d; };

// Every id in a document given a fresh prefix: the same library under ids that collide with nothing.
export const rekey = (doc, from, to) => JSON.parse(JSON.stringify(doc).replaceAll(`"${from}`, `"${to}`));
export { SPEC_CU1 };
