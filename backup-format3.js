// ─── Backup formats 1–3 and their conversion to format 4 (Stage 5) ────────────
// The only part of the page that names the retired storage fields (watchlist_items
// and tv_shows `collection`, personal_collections `legacy_source`, the
// othertv_shows table). Two jobs:
//   * while the database is in coexistence (stage5_capabilities phase
//     'coexistence', or an older database): backups are made and restored in
//     format 3 exactly as before (detectLegacyBackupFormat, the column lists and
//     validators below);
//   * once it is contracted: a format-3 file is never sent as it is. Restore
//     converts it explicitly (convertFormat3To4): the preview lists what the
//     conversion derives and what it can't keep, and refuses a file that breaks the
//     contracted rules. The file on disk is never changed. While the recovery
//     archive is active the converted document carries a recovery section (the
//     original storage values and othertv_shows rows); after it is retired that
//     section is left out and the preview says so.
// The format-3 export and direct-restore paths are retired after the contraction is
// verified; the converter stays (formats 1–2 stay refused as before).

// Every column of the three format-1 tables. A backup row must carry exactly these
// keys (key presence), and each value must fit the column type; a trailing "?"
// marks columns the database allows to be NULL.
const RESTORE_COLUMNS = {
  watchlist_items: {
    id: 'uuid', collection: 'text', item_key: 'text', title: 'text', season: 'text', theme: 'text',
    display_date: 'text', date_sort: 'date', watched: 'bool', status: 'text', created_at: 'timestamp',
    watch_with: 'text[]?', collections: 'text[]?', tmdb_collection_id: 'int?', tmdb_collection_name: 'text?',
    media_type: 'text?', tmdb_id: 'int?', season_number: 'int?'
  },
  othertv_shows: { id: 'uuid', tmdb_id: 'int', title: 'text', network: 'text', created_at: 'timestamp', collection: 'text' },
  custom_collections: { id: 'uuid', name: 'text', tmdb_person_id: 'int', created_at: 'timestamp', role: 'text?' }
};

// Format 2 (once the TV-show schema exists): watchlist_items gains show_id (TV
// seasons only) and skipped, and tv_shows is added. Like format 1, never user_id.
const RESTORE_COLUMNS_V2 = {
  ...RESTORE_COLUMNS,
  watchlist_items: { ...RESTORE_COLUMNS.watchlist_items, show_id: 'uuid?', skipped: 'bool' },
  tv_shows: { id: 'uuid', collection: 'text', title: 'text', show_key: 'text', tmdb_id: 'int?', status: 'text', created_at: 'timestamp' }
};

// Format 3 (once personal collections exist): adds your collections, which shows
// and films are in each, and your watch-with choices. Like formats 1 and 2, never
// user_id (nor the generated is_film / item_is_film).
const RESTORE_COLUMNS_V3 = {
  ...RESTORE_COLUMNS_V2,
  personal_collections: { id: 'uuid', name: 'text', legacy_source: 'text?', sort_order: 'int', archived_at: 'timestamp?', created_at: 'timestamp' },
  collection_memberships: { id: 'uuid', collection_id: 'uuid', show_id: 'uuid?', item_id: 'uuid?', created_at: 'timestamp' },
  watch_with_choices: { id: 'uuid', token: 'text', label: 'text', sort_order: 'int', archived_at: 'timestamp?', created_at: 'timestamp' }
};

const LEGACY_BACKUP_FORMATS = {
  1: { tables: ['watchlist_items', 'othertv_shows', 'custom_collections'], columns: RESTORE_COLUMNS },
  2: { tables: ['watchlist_items', 'tv_shows', 'othertv_shows', 'custom_collections'], columns: RESTORE_COLUMNS_V2 },
  3: { tables: ['watchlist_items', 'tv_shows', 'othertv_shows', 'custom_collections', 'personal_collections', 'collection_memberships', 'watch_with_choices'],
       columns: RESTORE_COLUMNS_V3 }
};
const LEGACY_SOURCES = ['disney', 'sheridan', '90day', 'truecrime'];
const LEGACY_STORAGE = ['disney', '90day', 'sheridan', 'othertv', 'truecrime', 'movies'];
const LEGACY_CATALOG_STORAGE = ['disney', '90day', 'sheridan'];
const FORMAT3_CONVERTER_VERSION = '5.1';

function legacyBackupSpec(formatVersion) {
  return LEGACY_BACKUP_FORMATS[formatVersion] || null;
}

// The format of a database without Stage 5's contraction: 3 once personal
// collections exist (personal_collections readable), 2 with the TV-show schema
// (tv_shows readable), otherwise 1. Read-only probes; any other answer is an error.
async function detectLegacyBackupFormat() {
  const probe = async table => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id&limit=1`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (res.ok) return true;
    const body = await res.text();
    if (res.status === 404 && body.includes('PGRST205')) return false;
    throw new Error(`Couldn't tell which backup format this database uses: ${res.status} ${body}`);
  };
  if (await probe('personal_collections')) return 3;
  return (await probe('tv_shows')) ? 2 : 1;
}

// Row-level checks for formats 1–3 that mirror that schema: storage-scoped
// identity keys, the season → show link within one storage, legacy sources.
function validateLegacyBackupRows(tables, formatVersion, report, rowLabel, findDuplicates) {
  const items = tables.watchlist_items.filter(r => r && typeof r === 'object');
  report('watchlist_items duplicate movie identity', findDuplicates(items,
    r => r.media_type === 'movie' && r.tmdb_id != null ? JSON.stringify([r.collection, r.tmdb_id]) : null,
    r => `(collection "${r.collection}", tmdb_id ${r.tmdb_id})`));
  report('watchlist_items duplicate TV identity', findDuplicates(items,
    r => r.media_type === 'tv' && r.tmdb_id != null && r.season_number != null ? JSON.stringify([r.collection, r.tmdb_id, r.season_number]) : null,
    r => `(collection "${r.collection}", tmdb_id ${r.tmdb_id}, season ${r.season_number})`));
  report('watchlist_items duplicate legacy entry', findDuplicates(items,
    r => r.tmdb_id === null ? JSON.stringify([r.collection, r.item_key]) : null,
    r => `(collection "${r.collection}", item_key "${r.item_key}")`));
  report('othertv_shows duplicate tracked show', findDuplicates(tables.othertv_shows.filter(r => r && typeof r === 'object'),
    r => JSON.stringify([r.collection, r.tmdb_id]), r => `(collection "${r.collection}", tmdb_id ${r.tmdb_id})`));
  if (formatVersion >= 2) {
    const shows = tables.tv_shows.filter(r => r && typeof r === 'object');
    const byId = new Map(shows.map(s => [s.id, s]));
    validateTvShowRows(shows, items, report, rowLabel, findDuplicates);
    report('tv_shows duplicate identified show', findDuplicates(shows, s => s.tmdb_id != null ? JSON.stringify([s.collection, s.tmdb_id]) : null,
      s => `(collection "${s.collection}", tmdb_id ${s.tmdb_id})`));
    report('tv_shows duplicate legacy show', findDuplicates(shows, s => s.tmdb_id == null ? JSON.stringify([s.collection, s.show_key]) : null,
      s => `(collection "${s.collection}", show_key "${s.show_key}")`));
    report('watchlist_items show links (storage)', items.map((r, i) => {
      const show = r.show_id != null ? byId.get(r.show_id) : null;
      return show && show.collection !== r.collection ? `${rowLabel(r, i)} links to a show in collection "${show.collection}"` : null;
    }).filter(Boolean));
  }
  if (formatVersion >= 3) {
    const colls = tables.personal_collections.filter(r => r && typeof r === 'object');
    validateOrganizationRows(tables, items, report, rowLabel, findDuplicates);
    report('personal_collections legacy source', colls.map((c, i) => c.legacy_source == null || LEGACY_SOURCES.includes(c.legacy_source) ? null : `${rowLabel(c, i)} has legacy_source ${JSON.stringify(c.legacy_source)}`).filter(Boolean));
    report('personal_collections duplicate legacy source', findDuplicates(colls, c => c.legacy_source ?? null, c => `"${c.legacy_source}"`));
  }
}

// ─── Converting a format-3 file to format 4 ───────────────────────────────────
// Deterministic, with exactly the contraction's rules (db/phase5c_contract.sql):
//   * a show stored with a built-in catalog (Disney+, 90 Day, Sheridan) is
//     governed by it (catalog_key = its show_key); a film stored there likewise
//     (entry_key = its item_key); origin migrated_from_storage;
//   * a film's theme means a genre when it was stored with Movies, otherwise not;
//   * a collection whose legacy_source is a catalog receives that catalog's new
//     records (catalog_id); every original collection keeps how the page presents it
//     (presentation_key: its note and remembered layout), True Crime / Docs included;
//     none of this places records;
//   * storage itself is not kept in the tables: with the recovery archive active,
//     the recovery section records every record's storage, every collection's
//     legacy_source and the othertv_shows rows (for a rollback); without it they
//     are listed as not kept.
// It refuses (returns refusals, never a document) when the file breaks a rule the
// contracted database enforces. sourceSha256: of the file's text, as read.
function convertFormat3To4(backup, { includeRecovery, sourceSha256, newId } = {}) {
  const t = backup.tables;
  const makeId = newId || (() => crypto.randomUUID());
  const refusals = [];
  const dupIds = (rows, keyOf) => {
    const seen = new Map(), out = [];
    for (const r of rows) { const k = keyOf(r); if (k == null) continue; if (seen.has(k)) out.push([seen.get(k), r.id]); else seen.set(k, r.id); }
    return out;
  };
  const say = (label, list) => { if (list.length) refusals.push(`${label}: ${list.slice(0, 5).map(x => (Array.isArray(x) ? x.join(' and ') : x)).join('; ')}${list.length > 5 ? ` …and ${list.length - 5} more` : ''}`); };
  const showsById = new Map(t.tv_shows.map(s => [s.id, s]));
  const isFilm = r => r.media_type === 'movie' || (r.media_type == null && r.season === 'Film');

  say('unknown storage', [...t.watchlist_items, ...t.tv_shows].filter(r => !LEGACY_STORAGE.includes(r.collection)).map(r => r.id));
  say('the same TMDB show more than once', dupIds(t.tv_shows, s => (s.tmdb_id != null ? String(s.tmdb_id) : null)));
  say('the same TMDB film more than once', dupIds(t.watchlist_items, r => (r.media_type === 'movie' && r.tmdb_id != null ? String(r.tmdb_id) : null)));
  say('the same TMDB season more than once', dupIds(t.watchlist_items, r => (r.media_type === 'tv' && r.tmdb_id != null && r.season_number != null ? `${r.tmdb_id}|${r.season_number}` : null)));
  say('two seasons of one show with the same key', dupIds(t.watchlist_items, r => (r.show_id ? `${r.show_id}|${r.item_key}` : null)));
  say('two shows of one catalog with the same key', dupIds(t.tv_shows, s => (LEGACY_CATALOG_STORAGE.includes(s.collection) ? `${s.collection}|${s.show_key}` : null)));
  say('two films of one catalog with the same key', dupIds(t.watchlist_items, r => (isFilm(r) && LEGACY_CATALOG_STORAGE.includes(r.collection) ? `${r.collection}|${r.item_key}` : null)));
  say('a season stored apart from its show', t.watchlist_items.filter(r => r.show_id && showsById.get(r.show_id) && showsById.get(r.show_id).collection !== r.collection).map(r => r.id));
  say('a row that is neither a film nor a linked TV season', t.watchlist_items.filter(r => !isFilm(r) && !r.show_id).map(r => r.id));
  say('a collection with an unknown legacy source', t.personal_collections.filter(c => c.legacy_source != null && !LEGACY_SOURCES.includes(c.legacy_source)).map(c => c.id));
  if (refusals.length) return { refusals };

  const stamp = backup.exportedAt;
  const items = t.watchlist_items.map(({ collection, ...r }) => ({ ...r, theme_kind: isFilm(r) ? (collection === 'movies' ? 'genre' : 'other') : null }));
  const shows = t.tv_shows.map(({ collection, ...s }) => s);
  const colls = t.personal_collections.map(({ legacy_source, ...c }) => ({ ...c, catalog_id: LEGACY_CATALOG_STORAGE.includes(legacy_source) ? legacy_source : null,
    presentation_key: LEGACY_SOURCES.includes(legacy_source) ? legacy_source : null }));
  const showLinks = t.tv_shows.filter(s => LEGACY_CATALOG_STORAGE.includes(s.collection))
    .map(s => ({ id: makeId(), catalog: s.collection, catalog_key: s.show_key, show_id: s.id, origin: 'migrated_from_storage', created_at: stamp }));
  const filmLinks = t.watchlist_items.filter(r => isFilm(r) && LEGACY_CATALOG_STORAGE.includes(r.collection))
    .map(r => ({ id: makeId(), catalog: r.collection, entry_key: r.item_key, item_id: r.id, origin: 'migrated_from_storage', created_at: stamp }));
  const tables = {
    watchlist_items: items, tv_shows: shows, custom_collections: t.custom_collections, personal_collections: colls,
    collection_memberships: t.collection_memberships, watch_with_choices: t.watch_with_choices,
    catalog_show_links: showLinks, catalog_film_links: filmLinks
  };
  const doc = {
    format: backup.format, formatVersion: 4, exportedAt: backup.exportedAt,
    rowCounts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), tables,
    conversion: { source_format: 3, source_exported_at: backup.exportedAt, source_sha256: sourceSha256, converter_version: FORMAT3_CONVERTER_VERSION }
  };
  if (includeRecovery) {
    doc.recovery = {
      storage_map: {
        items: t.watchlist_items.map(r => ({ id: r.id, collection: r.collection })),
        shows: t.tv_shows.map(s => ({ id: s.id, collection: s.collection })),
        personal_collections: t.personal_collections.map(c => ({ id: c.id, legacy_source: c.legacy_source ?? null }))
      },
      othertv_shows: t.othertv_shows
    };
  }
  const summary = {
    showLinks: showLinks.length, filmLinks: filmLinks.length,
    genreFilms: items.filter(r => r.theme_kind === 'genre').length, otherFilms: items.filter(r => r.theme_kind === 'other').length,
    catalogCollections: colls.filter(c => c.catalog_id).length,
    storageMappingsNotKept: t.personal_collections.filter(c => c.legacy_source && !LEGACY_CATALOG_STORAGE.includes(c.legacy_source)).map(c => c.name),
    storageKept: !!includeRecovery, records: t.watchlist_items.length + t.tv_shows.length, othertvShows: t.othertv_shows.length
  };
  return { refusals: [], doc, summary };
}

// The preview's list of what the conversion derives and what it doesn't keep.
function format3ConversionHtml(summary) {
  const li = text => `<li>${esc(text)}</li>`;
  const kept = summary.storageKept
    ? [li(`Where each of the ${summary.records} shows and rows was stored, and the ${summary.othertvShows} rows of the retired othertv_shows table, are kept in the recovery archive (for a rollback), not in your list.`)]
    : [li(`Not kept: where each of the ${summary.records} shows and rows was stored, and the ${summary.othertvShows} rows of the retired othertv_shows table (the recovery archive has been retired, so a rollback to before the update is no longer possible).`)];
  return `<div class="modal-section"><div class="modal-label">This is a format 3 backup; it is converted before restoring</div><ul class="manage-list">
    ${li(`${summary.showLinks} shows and ${summary.filmLinks} films governed by a built-in catalog (where they were stored with it).`)}
    ${li(`${summary.genreFilms} films whose theme is a genre, ${summary.otherFilms} whose theme is not (from where they were stored).`)}
    ${li(`${summary.catalogCollections} collections receive a catalog’s new entries.`)}
    ${summary.storageMappingsNotKept.length ? li(`${summary.storageMappingsNotKept.join(', ')}: kept as a collection with its members; its old storage link isn’t kept.`) : ''}
    ${kept.join('')}
    ${li('The file itself isn’t changed.')}</ul></div>`;
}
