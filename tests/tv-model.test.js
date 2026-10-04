// Offline tests for the TV-show model reference (tests/tv-model-reference.js):
// up next, Up to date, the status migration rules and the compatibility values
// for the deprecated season status. The same cases are run against the database
// implementation by tools/db-rehearsal.mjs.
// Run from the repo root: node tests/tv-model.test.js
const assert = require('assert');
const M = require('./tv-model-reference');
const { runner } = require('./app-harness');
const CASES = require('./fixtures/tv-model-cases.json');

const T = runner('tv-model');
const test = T.test;
const STATUSES = ['confirmed', 'highpriority', 'watching', 'complete', 'pending', 'maybe', 'skipped'];

for (const c of CASES.upNext) {
  test(`up next: ${c.name}`, () => {
    const seasons = M.caseSeasons(c.seasons, CASES.today);
    const next = M.upNext(seasons);
    assert.strictEqual(next ? next.id : null, c.upNext);
    assert.strictEqual(M.isUpToDate(seasons, CASES.today), c.upToDate);
  });
}

for (const c of CASES.migration) {
  test(`migration: ${c.name}`, () => {
    const seasons = c.statuses.map((status, i) => ({ id: `r${i}`, status }));
    const m = M.migrateShow(seasons);
    if (c.unmapped) { assert.ok(m.unmapped, 'expected unmapped'); return; }
    assert.strictEqual(m.status, c.status);
    assert.deepStrictEqual([...m.skippedIds].sort(), c.skipped.map(i => `r${i}`));
  });
}

// Every case show under every show status: the old app's aggregate status equals
// the show status, and for Watching its up next equals the new rule's (or, with
// nothing remaining, the anchor is already watched so the old app shows it as up
// to date). The one documented exception is a Watching show whose seasons are all
// skipped: the anchor is then its first (skipped, unwatched) season.
test('compatibility values: old app derives the same show status and up next', () => {
  let checked = 0;
  for (const c of CASES.upNext) {
    const seasons = M.caseSeasons(c.seasons, CASES.today);
    for (const status of STATUSES) {
      const proj = M.projectLegacyStatus(status, seasons);
      const old = seasons.map(r => ({ ...r, status: proj.get(r.id) }));
      assert.strictEqual(M.oldAggregateStatus(old), status, `${c.name} / ${status}`);
      if (status === 'watching') {
        const next = M.upNext(seasons);
        const oldNext = M.oldUpNext(old);
        const allSkipped = seasons.every(r => r.skipped);
        if (!allSkipped) assert.strictEqual(oldNext ? oldNext.id : null, next ? next.id : null, `${c.name} up next`);
      }
      checked++;
    }
  }
  assert.strictEqual(checked, CASES.upNext.length * STATUSES.length);
});

// Rolling back to the old model and re-deriving show status from the projected
// season statuses gives back the same show status and skip flags. Exceptions by
// design: a Skipped show's own season flags, and a Watching show whose every
// season is skipped (its anchor carries "watching").
test('compatibility values round-trip through the migration rules', () => {
  for (const c of CASES.upNext) {
    const seasons = M.caseSeasons(c.seasons, CASES.today);
    for (const status of STATUSES) {
      const proj = M.projectLegacyStatus(status, seasons);
      const back = M.migrateShow(seasons.map(r => ({ ...r, status: proj.get(r.id) })));
      assert.strictEqual(back.status, status, `${c.name} / ${status}`);
      if (status === 'skipped') { assert.strictEqual(back.skippedIds.size, 0); continue; }
      if (status === 'watching' && seasons.every(r => r.skipped)) continue;
      const flags = seasons.filter(r => r.skipped).map(r => r.id).sort();
      assert.deepStrictEqual([...back.skippedIds].sort(), flags, `${c.name} / ${status} flags`);
    }
  }
});

test('Watching anchor: up next, else furthest watched, else first season', () => {
  const S = spec => M.caseSeasons(spec, CASES.today);
  assert.strictEqual(M.watchingAnchor(S([['S1', 1, 'w'], ['S2', 2]])).id, 'S2');
  assert.strictEqual(M.watchingAnchor(S([['S1', 1, 'w'], ['S2', 2, 'w']])).id, 'S2');
  assert.strictEqual(M.watchingAnchor(S([['S2', 2, 's'], ['S1', 1, 's']])).id, 'S1');
});

test('show identity: TMDB id, else show key with the reviewed override', () => {
  const r = o => ({ collection: 'disney', media_type: null, tmdb_id: null, season: 'Season 1', ...o });
  assert.strictEqual(M.showIdentity(r({ item_key: 'the clone wars|season 7' })), 'disney|key:star wars: the clone wars (2008)');
  assert.strictEqual(M.showIdentity(r({ item_key: 'star wars: the clone wars (2008)|season 1' })), 'disney|key:star wars: the clone wars (2008)');
  assert.strictEqual(M.showIdentity(r({ collection: 'sheridan', item_key: 'the clone wars|season 7' })), 'sheridan|key:the clone wars');
  assert.strictEqual(M.showIdentity(r({ collection: 'othertv', media_type: 'tv', tmdb_id: 42, season_number: 1, item_key: 'x|season 1' })), 'othertv|tmdb:42');
});

test('films are never part of a show', () => {
  const rows = [
    { id: 'f', collection: 'disney', item_key: 'star wars: the clone wars (2008)|film', season: 'Film', media_type: null, tmdb_id: null, status: 'confirmed' },
    { id: 'm', collection: 'truecrime', item_key: 'x|film', season: 'Film', media_type: 'movie', tmdb_id: 9, status: 'confirmed' },
    { id: 's', collection: 'disney', item_key: 'star wars: the clone wars (2008)|season 1', season: 'Season 1', media_type: null, tmdb_id: null, status: 'confirmed' }
  ];
  const groups = M.groupShows(rows);
  assert.deepStrictEqual([...groups.values()].flat().map(r => r.id), ['s']);
});

test('show-key overrides match config.js once SHOW_KEY_OVERRIDES ships', () => {
  if (typeof M.app.SHOW_KEY_OVERRIDES === 'undefined') return; // added in Phase 1a
  assert.deepStrictEqual(JSON.parse(JSON.stringify(M.app.SHOW_KEY_OVERRIDES)), M.SHOW_KEY_OVERRIDES);
});

T.run();
