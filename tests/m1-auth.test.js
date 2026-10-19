// M1 (auth.js, api.js): sign-in, the signed-in session on every request, the page bound to one
// account, per-account remembered settings, the four write outcomes and the pending note that
// survives a closed tab, and a restore with no answer (observations only).
// Run from the repo root: node tests/m1-auth.test.js
const assert = require('assert');
const { createApp, runner, settle, HARNESS_USER, userKeyOf } = require('./app-harness');

const T = runner('m1-auth');
const test = T.test;
const OTHER = '0b000000-0000-4000-8000-0000000000bb';
const session = (id = HARNESS_USER, token = 'harness-token') => ({ access_token: token, user: { id, email: `${id.slice(0, 2)}@test.invalid` } });

function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { m, get length() { return m.size; }, key: i => [...m.keys()][i] ?? null,
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const linkedRow = n => ({ id: uuid(n), collection: 'othertv', item_key: `show ${n}|season 1`, title: `Show ${n}`, season: 'Season 1', theme: 'HBO',
  display_date: 'Jan 1, 2020', date_sort: '2020-01-01', watched: false, status: 'confirmed', created_at: '2026-01-01T00:00:00+00:00', watch_with: [],
  collections: [], tmdb_collection_id: null, tmdb_collection_name: null, media_type: 'tv', tmdb_id: n, season_number: 1, show_id: uuid(5000 + n), skipped: false });
const showRow = n => ({ id: uuid(5000 + n), collection: 'othertv', title: `Show ${n}`, show_key: `show ${n}`, tmdb_id: n, status: 'confirmed', created_at: '2026-01-01T00:00:00+00:00' });
const lib = (...ns) => ({ rows: ns.map(linkedRow), tvShows: ns.map(showRow) });
function reloads(app) { app.reloadCount = 0; app.ctx.location = Object.assign(app.ctx.location || {}, { reload: () => { app.reloadCount++; } }); }
// A change through the lane: creating a collection (the harness's org_create_collection).
const createCollection = (app, name = 'ZZ New') => app.run(`runWrite('Create collection', () => sbRpc('org_create_collection', { p_id: ${JSON.stringify(uuid(9100))}, p_name: ${JSON.stringify(name)} })).catch(e => (window.__lastError = e, null))`);
// The pending notes in storage for a user: { id: note } (one entry per note, watchlist_pending_write:<id>).
const notes = (storage, user = HARNESS_USER) => {
  const suffix = userKeyOf('', user), out = {};
  for (const [k, v] of storage.m) if (k.startsWith('watchlist_pending_write:') && k.endsWith(suffix)) out[k.slice('watchlist_pending_write:'.length, k.length - suffix.length)] = JSON.parse(v);
  return out;
};

// ─── Boot and sign-in ─────────────────────────────────────────────────────────
test('no saved session: the sign-in screen (email and password, the ask-the-owner line), no request at all', async () => {
  const app = await createApp({ ...lib(1), session: null });
  assert.deepStrictEqual(app.requests, [], 'nothing is read before sign-in');
  const html = app.el('authScreen').innerHTML;
  assert.match(html, /Sign in to Watchlist[\s\S]*type="email" autocomplete="email"[\s\S]*type="password" autocomplete="current-password"[\s\S]*Forgot your password\? Ask the library owner to reset it\./);
  assert.doesNotMatch(html, /code|Send code/i, 'no emailed code');
  assert.strictEqual(app.get('pageUser'), null);
});

test('sign-in with email and password; the field is cleared; the library is read with the session’s token', async () => {
  const app = await createApp({ ...lib(1), session: null });
  app.el('authEmail').value = 'owner@test.invalid';
  app.el('authPassword').value = 'harness password 1';
  await app.ctx.submitSignIn(); await settle(50);
  assert.strictEqual(JSON.stringify(app.authCalls[0]), JSON.stringify(['signin', { email: 'owner@test.invalid', password: '(right)' }]));
  assert.strictEqual(app.el('authPassword') ? app.el('authPassword').value : '', '', 'the password field is emptied');
  assert.strictEqual(JSON.parse(app.get('JSON.stringify(pageUser)')).id, HARNESS_USER);
  assert.ok(app.requests.length > 1, 'the library is read');
  assert.ok(app.requests.every(r => r.headers.Authorization === 'Bearer harness-token'), 'every request carries the session token');
  assert.strictEqual(app.el('authScreen').innerHTML, '');
});

test('a wrong password or an unknown email: one generic sentence (never which); a rate limit: its own sentence; nothing read', async () => {
  const app = await createApp({ ...lib(1), session: null });
  for (const [email, pw] of [['owner@test.invalid', 'wrong'], ['nobody@test.invalid', 'harness password 1']]) {
    app.el('authEmail').value = email; app.el('authPassword').value = pw;
    await app.ctx.submitSignIn(); await settle();
    assert.match(app.el('authScreen').innerHTML, /That email and password didn’t match an account\./);
  }
  app.signInError = { message: 'Request rate limit reached', code: 'over_request_rate_limit' };
  app.el('authEmail').value = 'owner@test.invalid'; app.el('authPassword').value = 'harness password 1';
  await app.ctx.submitSignIn(); await settle();
  assert.match(app.el('authScreen').innerHTML, /Too many sign-in attempts just now/);
  assert.deepStrictEqual(app.requests, []);
});

test('nothing typed is kept: no password in storage, page state or the sign-in screen', async () => {
  const storage = memStorage();
  const app = await createApp({ ...lib(1), session: null, storage });
  app.el('authEmail').value = 'owner@test.invalid'; app.el('authPassword').value = 'harness password 1';
  await app.ctx.submitSignIn(); await settle(50);
  assert.ok(![...storage.m.values()].some(v => v.includes('harness password 1')), 'not in storage');
  assert.ok(!JSON.stringify(app.get('signInState')).includes('harness password 1'), 'not in page state');
});

test('Change password: the current password goes to Auth, which refuses a wrong one (nothing changed); only one sign-in session exists', async () => {
  const app = await createApp({ ...lib(1) });
  app.ctx.openSettings(null);
  const fill = (cur, a, b) => { app.el('accountCurrentPassword').value = cur; app.el('accountNewPassword').value = a; app.el('accountNewPassword2').value = b; };
  fill('wrong current', 'a brand new password', 'a brand new password');
  await app.ctx.changePassword(); await settle();
  assert.match(app.el('settingsAccountNote').textContent, /current password isn’t right\. Nothing was changed\./);
  assert.strictEqual(JSON.stringify(app.authCalls.filter(c => c[0] === 'updateUser').pop()), JSON.stringify(['updateUser', { password: '(new)', current_password: '(wrong)' }]), 'sent; Auth refused it');
  assert.strictEqual(app.password, 'harness password 1', 'unchanged');
  fill('harness password 1', 'too short', 'too short');
  await app.ctx.changePassword(); await settle();
  assert.match(app.el('settingsAccountNote').textContent, /at least 12 characters/);
  fill('harness password 1', 'a brand new password', 'a different one entirely');
  await app.ctx.changePassword(); await settle();
  assert.match(app.el('settingsAccountNote').textContent, /don’t match/);
  fill('harness password 1', 'a brand new password', 'a brand new password');
  await app.ctx.changePassword(); await settle();
  assert.match(app.el('settingsAccountNote').textContent, /Your password has been changed/);
  assert.strictEqual(JSON.stringify(app.authCalls.filter(c => c[0] === 'updateUser').pop()), JSON.stringify(['updateUser', { password: '(new)', current_password: '(right)' }]));
  assert.ok(!app.authCalls.some(c => /^probe/.test(c[0])), 'no extra sign-in');
  assert.ok(app.session, 'the page stays signed in');
  ['accountCurrentPassword', 'accountNewPassword', 'accountNewPassword2'].forEach(id => assert.strictEqual(app.el(id).value, '', `${id} emptied`));
});

test('Sign out other devices: scope others; this page stays signed in', async () => {
  const app = await createApp({ ...lib(1) });
  app.ctx.openSettings(null);
  await app.ctx.signOutOtherDevices(); await settle();
  assert.strictEqual(JSON.stringify(app.authCalls.find(c => c[0] === 'signOut')), JSON.stringify(['signOut', { scope: 'others' }]));
  assert.ok(app.session && !app.get('authStopped'));
  assert.match(app.el('settingsAccountNote').textContent, /Every other device and browser/);
});

test('a database not in the signed-in state (no access = members): its notice; only the capability is read', async () => {
  const app = await createApp({ ...lib(1), access: null });
  assert.match(app.el('phaseBanner').innerHTML, /hasn’t been updated for signed-in libraries yet/);
  assert.deepStrictEqual(app.requests.map(r => r.url.split('/rest/v1/')[1]), ['rpc/stage5_capabilities']);
});

test('remembered settings are per account; the old un-namespaced ones are discarded at sign-in', async () => {
  const storage = memStorage({ watchlist_last_backup_at: '2026-01-01T00:00:00Z', watchlist_alltv_presentation: 'seasons', watchlist_browse_layout_disney: '{}',
    unrelated_key: 'kept', [userKeyOf('watchlist_alltv_presentation', OTHER)]: 'seasons' });
  const app = await createApp({ ...lib(1), storage });
  assert.ok(!storage.m.has('watchlist_last_backup_at') && !storage.m.has('watchlist_alltv_presentation') && !storage.m.has('watchlist_browse_layout_disney'), 'legacy keys removed');
  assert.strictEqual(storage.getItem('unrelated_key'), 'kept');
  assert.strictEqual(app.get('readAllTvPresentation()'), 'shows', 'another account’s choice doesn’t apply');
  app.ctx.recordBackupTimestamp();
  assert.ok(storage.m.has(userKeyOf('watchlist_last_backup_at')) && !storage.m.has(userKeyOf('watchlist_last_backup_at', OTHER)));
});

// ─── The session on every request ─────────────────────────────────────────────
test('the session ended (no session any more): a change is refused before anything is sent; the notice offers sign-in', async () => {
  const app = await createApp({ ...lib(1) });
  app.session = null;
  const before = app.requests.length;
  await createCollection(app); await settle();
  assert.strictEqual(app.requests.length, before, 'nothing sent');
  assert.match(String(app.get('window.__lastError && window.__lastError.message')), /not_signed_in: .*nothing was sent and nothing was changed/);
  assert.match(app.el('phaseBanner').innerHTML, /Your sign-in has ended[\s\S]*Sign in again/);
});

test('another account signed in elsewhere in this browser: nothing is sent from this page; it reloads (lane free, nothing unknown)', async () => {
  const app = await createApp({ ...lib(1) });
  reloads(app);
  app.session = session(OTHER, 'other-token');
  const before = app.requests.length;
  await createCollection(app); await settle();
  assert.strictEqual(app.requests.length, before, 'nothing sent with the other account’s token');
  assert.strictEqual(app.reloadCount, 1);
  assert.strictEqual(app.get('authStopped'), true);
});

test('an Auth event for another account while a change is out: the reload waits for the lane; nothing more is sent', async () => {
  const app = await createApp({ ...lib(1) });
  reloads(app);
  const g = app.hold(r => r.url.includes('/rpc/org_create_collection'));
  const p = createCollection(app); await g.reached; await settle();
  app.authEvent('SIGNED_IN', session(OTHER, 'other-token')); await settle();
  assert.strictEqual(app.reloadCount, 0, 'not while the change is out');
  g.release(); await p; await settle(50);
  assert.strictEqual(app.reloadCount, 1, 'after it answered');
});

test('a 401 (the token was rejected): a confirmed refusal, nothing changed; the sign-in notice', async () => {
  const app = await createApp({ ...lib(1), storage: memStorage() });
  app.refuseNext(r => r.url.includes('/rpc/org_create_collection'), 'PGRST303', 'JWT expired');
  await createCollection(app); await settle();
  assert.match(String(app.get('window.__lastError.message')), /JWT expired/);
  assert.deepStrictEqual(app.store.personal_collections.filter(c => c.name === 'ZZ New'), []);
});

// ─── Write outcomes and the pending note ──────────────────────────────────────
test('done or refused: the note saved before sending is cleared; no answer (lost, or a 5xx without a database code): it stays', async () => {
  const storage = memStorage();
  const app = await createApp({ ...lib(1), storage });
  const g = app.hold(r => r.url.includes('/rpc/org_create_collection'));
  const pa = createCollection(app, 'A'); await g.reached;
  const seen = notes(storage);
  g.release(); await pa; await settle();
  assert.strictEqual(Object.keys(seen || {}).length, 1, 'saved before the request was sent');
  assert.match(Object.values(seen)[0].what, /Create collection/);
  assert.deepStrictEqual(notes(storage), {}, 'done: cleared');
  app.refuseNext(r => r.url.includes('/rpc/org_create_collection'), '23505', 'collection_exists: refused');
  await createCollection(app, 'B'); await settle();
  assert.deepStrictEqual(notes(storage), {}, 'refused: cleared');
  app.failNext(r => r.url.includes('/rpc/org_create_collection'));
  await createCollection(app, 'C'); await settle();
  assert.strictEqual(Object.keys(notes(storage)).length, 1, 'a 5xx without a database code: kept');
  app.loseNext(r => r.url.includes('/rpc/org_create_collection'), 'after');
  await createCollection(app, 'D'); await settle();
  assert.strictEqual(Object.keys(notes(storage)).length, 2, 'lost answer: kept');
  assert.strictEqual(app.get('unknownOutcomesHere().length'), 2);
  assert.strictEqual(app.writes().filter(r => r.url.includes('org_create_collection')).length, 4, 'nothing was ever resent');
});

test('a closed tab after sending: the next page for that account shows the unknown outcome until acknowledged (never deleted); another account never sees it', async () => {
  const storage = memStorage();
  const app = await createApp({ ...lib(1), storage });
  // The page goes away while the request is out: the note is already saved.
  const g = app.hold(r => r.url.includes('/rpc/org_create_collection'));
  createCollection(app, 'Closed'); await g.reached; await settle();
  assert.strictEqual(Object.keys(notes(storage)).length, 1);
  const other = await createApp({ ...lib(1), storage, session: session(OTHER) });
  assert.strictEqual(other.el('unknownBanner').innerHTML, '', 'not shown to another account');
  const next = await createApp({ ...lib(1), storage });
  assert.match(next.el('unknownBanner').innerHTML, /hasn’t been confirmed[\s\S]*may or may not have been made[\s\S]*Create collection[\s\S]*Nothing was sent again/);
  next.ctx.acknowledgeShownNotes();
  assert.strictEqual(next.el('unknownBanner').innerHTML, '', 'hidden once acknowledged');
  assert.strictEqual(Object.keys(notes(storage)).length, 1, 'acknowledging deletes nothing: the note remains, unresolved');
  const later = await createApp({ ...lib(1), storage });
  assert.strictEqual(later.el('unknownBanner').innerHTML, '', 'that version stays acknowledged');
});

test('one tab never clears another tab’s note', async () => {
  const storage = memStorage();
  const a = await createApp({ ...lib(1), storage });
  const g = a.hold(r => r.url.includes('/rpc/org_create_collection'));
  createCollection(a, 'From A'); await g.reached; await settle();
  const b = await createApp({ ...lib(1), storage });
  await createCollection(b, 'From B'); await settle();
  assert.strictEqual(Object.keys(notes(storage)).length, 1, 'B’s confirmed change cleared only its own note');
  assert.match(Object.values(notes(storage))[0].what, /Create collection/);
});

test('an account change with an unknown outcome pending: no reload until “I understand”; the note stays for that account', async () => {
  const storage = memStorage();
  const app = await createApp({ ...lib(1), storage });
  reloads(app);
  app.loseNext(r => r.url.includes('/rpc/org_create_collection'), 'after');
  await createCollection(app); await settle();
  app.authEvent('SIGNED_OUT', null); await settle();
  assert.strictEqual(app.reloadCount, 0);
  assert.match(app.el('authModalBox').innerHTML, /got no answer[\s\S]*I understand — reload/);
  app.ctx.reloadPage();
  assert.strictEqual(app.reloadCount, 1);
  assert.strictEqual(Object.keys(notes(storage)).length, 1, 'kept for the next sign-in');
});

test('sign out: this device only (scope local), refused while a change is out', async () => {
  const app = await createApp({ ...lib(1) });
  reloads(app);
  const g = app.hold(r => r.url.includes('/rpc/org_create_collection'));
  const p = createCollection(app); await g.reached; await settle();
  await app.ctx.signOutHere();
  assert.ok(!app.authCalls.some(c => c[0] === 'signOut'), 'not while the lane is held');
  g.release(); await p; await settle();
  await app.ctx.signOutHere(); await settle();
  assert.strictEqual(JSON.stringify(app.authCalls.find(c => c[0] === 'signOut')), JSON.stringify(['signOut', { scope: 'local' }]));
  assert.strictEqual(app.reloadCount, 1);
});

test('Settings shows the account, Sign out, Sign out other devices and Change password', async () => {
  const app = await createApp({ ...lib(1) });
  app.ctx.openSettings(null);
  assert.match(app.el('settingsScreen').innerHTML, /Signed in as <strong>owner@test\.invalid<\/strong>[\s\S]*Sign out on this device[\s\S]*Sign out other devices[\s\S]*Change password/);
});

// ─── Restore with no answer ───────────────────────────────────────────────────
async function restoreSetup(storage, same = false) {
  const app = await createApp({ ...lib(1), storage });
  // same: the file is a backup of this very library (so it equals the safety backup).
  const src = same ? app : await createApp({ ...lib(7) });
  const backup = JSON.parse(JSON.stringify(await src.run('buildBackupObject()')));
  app.ctx.openSettings(null);
  app.ctx.__backup = backup;
  app.run(`pendingRestoreData = __backup`);
  const safety = JSON.parse(JSON.stringify(await app.run('buildBackupObject()')));
  app.ctx.__safety = safety;
  app.run(`pendingSafetyBackup = { filename: 'safety.json', doc: __safety }`);
  return app;
}
test('a restore whose answer is lost after it ran: “outcome unknown”, what the library matches (the file), never “nothing was changed”; the note keeps the safety backup', async () => {
  const storage = memStorage();
  const app = await restoreSetup(storage);
  app.loseNext(r => r.url.includes('/rpc/restore_backup'), 'after');
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle(50);
  const html = app.el('restoreModalBox').innerHTML;
  assert.match(html, /Restore outcome unknown/);
  assert.match(html, /currently matches the restore file/);
  assert.match(html, /doesn’t show whether the restore request finished/);
  assert.doesNotMatch(html, /nothing was changed/i);
  assert.doesNotMatch(html, /continueRestore|Try again|Retry/, 'no retry offered');
  assert.strictEqual(Object.values(notes(storage))[0].safetyBackup, 'safety.json');
  assert.strictEqual(app.writes().filter(r => r.url.includes('restore_backup')).length, 1);
});
test('a restore with a gateway error (no database code) that didn’t run: unknown; the library matches the safety backup, reported as an observation', async () => {
  const app = await restoreSetup(memStorage());
  app.failNext(r => r.url.includes('/rpc/restore_backup'));
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle(50);
  const html = app.el('restoreModalBox').innerHTML;
  assert.match(html, /Restore outcome unknown[\s\S]*currently matches the safety backup/);
  assert.doesNotMatch(html, /nothing was changed/i);
});
test('when the file and the safety backup hold the same data, the comparison says so and decides nothing', async () => {
  const app = await restoreSetup(memStorage(), true);
  app.loseNext(r => r.url.includes('/rpc/restore_backup'), 'before');
  await app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await settle(50);
  assert.match(app.el('restoreModalBox').innerHTML, /may or may not have been made[\s\S]*matches both the restore file and the safety backup/);
});

// ─── Correction batch (Codex review): acknowledgement, membership, Auth outcomes ───
test('another tab acknowledging a warning while the request is still in progress never removes it; a later no-answer shows it again', async () => {
  const storage = memStorage();
  const a = await createApp({ ...lib(1), storage });
  const g = a.hold(r => r.url.includes('/rpc/org_create_collection'));
  const p = createCollection(a, 'Live in A'); await g.reached; await settle();
  const b = await createApp({ ...lib(1), storage });
  assert.match(b.el('unknownBanner').innerHTML, /may still be in progress in another tab/);
  b.ctx.acknowledgeShownNotes();
  assert.strictEqual(Object.keys(notes(storage)).length, 1, 'A’s note survives B’s acknowledgement');
  g.lose('after'); await p; await settle();
  const n = Object.values(notes(storage))[0];
  assert.strictEqual(n.version, 2, 'A’s no-answer raised the version');
  const c = await createApp({ ...lib(1), storage });
  assert.match(c.el('unknownBanner').innerHTML, /Create collection/, 'shown again: the acknowledged version is older');
});
test('a confirmed answer in the originating tab deletes its note (and an acknowledgement of it); another tab’s acknowledgement deletes nothing', async () => {
  const storage = memStorage();
  const a = await createApp({ ...lib(1), storage });
  const g = a.hold(r => r.url.includes('/rpc/org_create_collection'));
  const p = createCollection(a, 'Confirmed later'); await g.reached; await settle();
  const b = await createApp({ ...lib(1), storage });
  b.ctx.acknowledgeShownNotes();
  g.release(); await p; await settle();
  assert.deepStrictEqual(notes(storage), {});
  assert.ok(![...storage.m.keys()].some(k => k.startsWith('watchlist_pending_ack:')), 'its acknowledgement went with it');
});
test('two tabs writing notes at the same moment keep both (one entry per note)', async () => {
  const storage = memStorage();
  const a = await createApp({ ...lib(1), storage }), b = await createApp({ ...lib(1), storage });
  const ga = a.hold(r => r.url.includes('/rpc/org_create_collection')), gb = b.hold(r => r.url.includes('/rpc/org_create_collection'));
  createCollection(a, 'From A'); createCollection(b, 'From B');
  await ga.reached; await gb.reached; await settle();
  assert.strictEqual(Object.keys(notes(storage)).length, 2);
});
test('an unanswered restore keeps its warning (with its safety backup) after another tab acknowledged an earlier version', async () => {
  const storage = memStorage();
  const app = await restoreSetup(storage);
  const g = app.hold(r => r.url.includes('/rpc/restore_backup'));
  const p = app.run(`continueRestoreAfterSafetyConfirm('safety.json')`); await g.reached; await settle();
  const other = await createApp({ ...lib(1), storage });
  other.ctx.acknowledgeShownNotes();
  g.lose('after'); await p; await settle(50);
  const next = await createApp({ ...lib(1), storage });
  assert.match(next.el('unknownBanner').innerHTML, /Restore from a backup file[\s\S]*Safety backup taken before it: safety\.json/);
});

test('a signed-in account that is not a member: no library is read; the account controls stay; no backup file', async () => {
  // A page that signs in while the account isn't a member:
  const page = await createAppNonMember();
  assert.match(page.el('phaseBanner').innerHTML, /has no library here/);
  assert.deepStrictEqual(page.requests.map(r => r.url.split('/rest/v1/')[1]), ['rpc/stage5_capabilities'], 'nothing but the capability is read');
  assert.match(page.el('authScreen').innerHTML, /Sign out on this device[\s\S]*Sign out other devices[\s\S]*Change password/);
  const res = await page.run('buildBackupObject()').then(() => 'made', e => e.message);
  assert.match(res, /has no library here[\s\S]*No file was made/);
});
async function createAppNonMember() {
  // The harness reads app.member when answering the capability; set it before boot via a session-less boot.
  const app = await createApp({ ...lib(1), session: null });
  app.member = false;
  app.session = session();
  await app.ctx.startSignedIn(app.session.user); await settle(30);
  return app;
}
test('a membership that ends while a backup is being read: no file (the check after the reads refuses)', async () => {
  const app = await createApp({ ...lib(1) });
  const g = app.hold(r => r.url.includes('/rest/v1/tv_shows'));
  const p = app.run('buildBackupObject()').then(() => 'made', e => e.message);
  await g.reached; app.member = false; g.release();
  assert.match(await p, /It ended while the backup was being read\.\) No file was made\./);
});
test('an active member with an empty library: a valid, empty backup', async () => {
  const app = await createApp({ rows: [], tvShows: [] });
  const doc = JSON.parse(JSON.stringify(await app.run('buildBackupObject()')));
  assert.deepStrictEqual(Array.from(app.get('validateBackupObject')(doc)), []);
  assert.strictEqual(doc.tables.watchlist_items.length, 0);
});
test('a change refused with not_a_member (membership ended mid-session): the page stops writing', async () => {
  const app = await createApp({ ...lib(1) });
  app.refuseNext(r => r.url.includes('/rpc/org_create_collection'), '42501', 'not_a_member: This account has no library here. Nothing was changed.');
  await createCollection(app); await settle();
  assert.match(app.el('phaseBanner').innerHTML, /has no library here[\s\S]*changes nothing more/);
  const before = app.requests.length;
  await createCollection(app, 'After'); await settle();
  assert.strictEqual(app.writes().filter(r => r.url.includes('org_create_collection')).length, 1, 'nothing more sent');
});

test('Change password whose answer is lost after Auth made the change: “may or may not”, never “not changed”', async () => {
  const app = await createApp({ ...lib(1) });
  app.ctx.openSettings(null);
  app.loseUpdateUser = true;
  app.el('accountCurrentPassword').value = 'harness password 1'; app.el('accountNewPassword').value = 'a brand new password'; app.el('accountNewPassword2').value = 'a brand new password';
  await app.ctx.changePassword(); await settle();
  assert.match(app.el('settingsAccountNote').textContent, /may or may not have been changed[\s\S]*try the new password first/);
  assert.doesNotMatch(app.el('settingsAccountNote').textContent, /wasn’t changed|Nothing was changed/);
  assert.strictEqual(app.password, 'a brand new password', '(the stand-in Auth did change it)');
});
test('Sign out other devices with an unrecognised error: “may or may not”', async () => {
  const app = await createApp({ ...lib(1) });
  app.ctx.openSettings(null);
  app.signOutError = { message: 'Bad gateway', status: 502 };
  await app.ctx.signOutOtherDevices(); await settle();
  assert.match(app.el('settingsAccountNote').textContent, /may or may not have been signed out/);
});

T.run();
