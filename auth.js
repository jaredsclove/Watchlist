// ─── Sign-in and the signed-in library (M1) ───────────────────────────────────
// Supabase Auth (the vendored supabase-js, used for Auth only) keeps the session in this
// browser and refreshes it; the database decides what the session may read and change.
//
// One page, one account: the page binds the signed-in user at boot (pageUser) and everything
// it holds belongs to that user. Every request takes the session's current access token
// (authHeaders) and is refused before it is sent when there is no session, the session can't
// be refreshed, or the session now belongs to someone else. A change of account (a sign-out,
// or another sign-in in another tab: tabs share the session) stops the page and reloads it;
// with an unknown outcome pending it waits for the person to read the warning first.
//
// Write outcomes (api.js): not sent, refused, done, or unknown. Before each write is sent the
// page saves a short note for this user in this browser (what, when; never the request); a
// confirmed answer (done or refused) clears it. A note left over (the answer was lost, the tab
// closed or crashed after sending) is shown at the next load for that user as an unknown
// outcome, until the person dismisses it. Nothing is ever sent again.

const AUTH_NOT_SENT_TEXT = 'You’re not signed in (or your sign-in has ended), so nothing was sent and nothing was changed. Sign in again.';
// Remembered settings from before sign-in existed: not tied to any account, so discarded (plan D9).
const LEGACY_STORAGE_KEYS = ['watchlist_last_backup_at', 'watchlist_last_collection', 'watchlist_alltv_presentation'];
const LEGACY_STORAGE_PREFIXES = ['watchlist_browse_layout_'];

let authClientInstance = null;
let pageUser = null; // { id, email }: the account this page was loaded for; null until bound
let authStopped = false; // an account change or sign-out: nothing more is sent from this page
let authAckPending = false; // the account changed while an outcome was unknown: waiting for "I understand"
let pageNoteSeq = 0;
let signInState = { email: '', busy: false, message: '' };

function authClient() {
  if (!authClientInstance) {
    authClientInstance = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      // The page's routes use the URL hash, so sessions never come from the URL.
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
  }
  return authClientInstance;
}

// A request refused before it was sent, in the database's refusal shape: callers report that
// nothing was changed, as for any refusal.
function authNotSentError(text = AUTH_NOT_SENT_TEXT) {
  const e = new Error(`Supabase error 412: ${JSON.stringify({ code: 'P0001', details: null, hint: null, message: `not_signed_in: ${text}` })}`);
  e.notSent = true;
  return e;
}

// The headers for one request, from the session as it is now; refuses (nothing sent) otherwise.
async function authHeaders(extra = {}) {
  if (authStopped || !pageUser) throw authNotSentError();
  let session = null;
  try { const { data, error } = await authClient().auth.getSession(); session = !error && data ? data.session : null; } catch (e) { session = null; }
  if (!session || !session.access_token || !session.user) { sessionLost(); throw authNotSentError(); }
  if (session.user.id !== pageUser.id) { accountChanged(); throw authNotSentError('This browser is now signed in to another account, so nothing was sent from this page. It will reload.'); }
  return { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${session.access_token}`, ...extra };
}

// ── Per-user storage ──
function userKey(key) { return pageUser ? `${key}::${pageUser.id}` : null; }
const userStorage = {
  getItem(key) { const k = userKey(key); return k ? localStorage.getItem(k) : null; },
  setItem(key, value) { const k = userKey(key); if (!k) throw new Error('no signed-in user'); localStorage.setItem(k, value); },
  removeItem(key) { const k = userKey(key); if (k && typeof localStorage.removeItem === 'function') localStorage.removeItem(k); }
};
function discardLegacyStorage() {
  try {
    LEGACY_STORAGE_KEYS.forEach(k => { if (localStorage.getItem(k) !== null) localStorage.removeItem(k); });
    if (typeof localStorage.length === 'number' && typeof localStorage.key === 'function') {
      const old = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && !k.includes('::') && LEGACY_STORAGE_PREFIXES.some(p => k.startsWith(p))) old.push(k); }
      old.forEach(k => localStorage.removeItem(k));
    }
  } catch (e) { /* storage unavailable */ }
}

// ── Pending notes (unknown outcomes survive a closed tab) ──
// One storage entry per note (watchlist_pending_write:<id>), so tabs never overwrite each other's notes. A
// note has a version; acknowledging it records the version shown (watchlist_pending_ack:<id>) and means only
// "I understand this remains unresolved": it never deletes the note and never says the request finished or
// failed. Only the tab that sent the request deletes its note, after a confirmed answer. If that tab's request
// then ends with no answer, it raises the version, so the warning is shown again even if an earlier version
// was acknowledged (for example while the request was still in progress in that tab).
const NOTE_PREFIX = 'watchlist_pending_write:', ACK_PREFIX = 'watchlist_pending_ack:';
let pageNoteVersions = new Map(); // id → version, for the notes this page wrote and hasn't seen answered
let pageUnknown = new Set(); // the ids of this page's requests that ended with no answer
let shownNotes = []; // [{ id, version }]: what the warning on screen shows, for acknowledgement
function storageKeys() {
  try {
    if (typeof localStorage.length !== 'number' || typeof localStorage.key !== 'function') return [];
    const out = []; for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i)); return out;
  } catch (e) { return []; }
}
function noteIds() {
  const suffix = userKey('');
  return storageKeys().filter(k => k && k.startsWith(NOTE_PREFIX) && k.endsWith(suffix)).map(k => k.slice(NOTE_PREFIX.length, k.length - suffix.length));
}
function readNote(id) { try { const v = JSON.parse(userStorage.getItem(NOTE_PREFIX + id)); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } }
function writeNote(id, note) { try { userStorage.setItem(NOTE_PREFIX + id, JSON.stringify(note)); return true; } catch (e) { return false; } }
function ackedVersion(id) { try { return Number(userStorage.getItem(ACK_PREFIX + id)) || 0; } catch (e) { return 0; } }
let notesUnavailableShown = false;
// Saved immediately before a write is sent. Returns its id.
function savePendingNote(what, extra = {}) {
  const id = `${Date.now().toString(36)}-${(++pageNoteSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const note = { what: String(what || 'A change'), at: new Date().toISOString(), version: 1, ...extra };
  if (!writeNote(id, note) && !notesUnavailableShown) {
    notesUnavailableShown = true;
    if (typeof showError === 'function') showError('This browser isn’t keeping notes about changes in progress, so if this page closes while a change is out, it can’t warn you about it later.');
  }
  pageNoteVersions.set(id, 1);
  return id;
}
// A confirmed answer (done or refused) for that request: its note (and any acknowledgement of it) goes. Only
// the page that wrote a note deletes it, by its id.
function clearPendingNote(id) {
  if (!id || !pageNoteVersions.has(id)) return;
  pageNoteVersions.delete(id); pageUnknown.delete(id);
  try { userStorage.removeItem(NOTE_PREFIX + id); userStorage.removeItem(ACK_PREFIX + id); } catch (e) { /* storage unavailable */ }
}
// No answer: the note stays, with a new version (shown again even if an earlier version was acknowledged); it
// is written again in case it was missing.
function keepPendingNote(id) {
  if (!id) return;
  const prev = readNote(id) || {};
  const version = Math.max(pageNoteVersions.get(id) || 1, Number(prev.version) || 1) + 1;
  writeNote(id, { ...prev, version, noAnswerAt: new Date().toISOString() });
  pageNoteVersions.set(id, version); pageUnknown.add(id);
}
function unknownOutcomesHere() { return [...pageUnknown].filter(id => readNote(id)); }

// The unresolved notes of other pages and earlier visits that aren't acknowledged at their current version.
function showLeftoverNotes() {
  const el = document.getElementById('unknownBanner');
  if (!el) return;
  const notes = noteIds().filter(id => !pageNoteVersions.has(id)).map(id => ({ id, n: readNote(id) }))
    .filter(x => x.n && (Number(x.n.version) || 1) > ackedVersion(x.id))
    .sort((a, b) => String(a.n.at).localeCompare(String(b.n.at)));
  shownNotes = notes.map(x => ({ id: x.id, version: Number(x.n.version) || 1 }));
  if (!notes.length) { el.innerHTML = ''; return; }
  const items = notes.map(x => `<li>${esc(x.n.what)} <span class="unknown-when">(${esc(formatNoteTime(x.n.at))})</span>${x.n.safetyBackup ? `<br>Safety backup taken before it: ${esc(x.n.safetyBackup)}` : ''}</li>`).join('');
  el.innerHTML = `<div class="error-banner unknown-banner" role="alert">⚠️ ${notes.length === 1 ? 'A change' : `${notes.length} changes`} sent from this browser ${notes.length === 1 ? 'hasn’t' : 'haven’t'} been confirmed: ${notes.length === 1 ? 'it' : 'each'} may still be in progress in another tab, or got no answer, so it may or may not have been made:
    <ul>${items}</ul>Check what is saved now. Nothing was sent again.
    <button class="btn" onclick="acknowledgeShownNotes()">I understand these remain unresolved — hide</button></div>`;
}
// Records that exactly the versions shown were seen. Nothing is deleted.
function acknowledgeShownNotes() {
  shownNotes.forEach(x => { try { userStorage.setItem(ACK_PREFIX + x.id, String(x.version)); } catch (e) { /* storage unavailable */ } });
  showLeftoverNotes();
}
function formatNoteTime(iso) { const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString(); }

// ── Account changes and lost sessions ──
function stopPageForAuth(text) {
  authStopped = true;
  if (typeof stopB45Writes === 'function') { b45Stopped = true; stage5Phase = null; }
  const el = document.getElementById('phaseBanner');
  if (el) el.innerHTML = `<div class="error-banner">⚠️ ${esc(text)}</div>`;
}
function accountChanged() {
  if (authStopped && !authAckPending) { finishAccountChange(); return; }
  stopPageForAuth('This browser’s sign-in changed, so this page changes nothing more. It will reload for the account now signed in.');
  finishAccountChange();
}
function finishAccountChange() {
  if (writeLane) { if (!writeLane.after.includes(finishAccountChange)) writeLane.after.push(finishAccountChange); return; }
  if (unknownOutcomesHere().length) { authAckPending = true; renderAccountChangeAck(); return; }
  reloadPage();
}
function renderAccountChangeAck() {
  const items = unknownOutcomesHere().map(id => { const n = readNote(id) || {}; return `<li>${esc(n.what || 'A change')}${n.safetyBackup ? ` (safety backup: ${esc(n.safetyBackup)})` : ''}</li>`; }).join('');
  showAuthOverlay(`<div class="modal-title">The sign-in changed while a change had no answer</div>
    <div class="modal-error">This page sent a change that got no answer, so it may or may not have been made:<ul>${items}</ul>
It wasn’t sent again. When you next sign in to that account, this warning is shown again until you dismiss it.</div>
    <div class="modal-actions"><button class="btn btn-accent" onclick="reloadPage()">I understand — reload</button></div>`);
}
// The session can't be used any more (signed out elsewhere, refresh failed): nothing more is sent.
// The same account signing in again in this tab continues; any other account reloads.
function sessionLost() {
  if (authStopped) return;
  const el = document.getElementById('phaseBanner');
  if (el) el.innerHTML = `<div class="error-banner">⚠️ Your sign-in has ended, so changes are refused until you sign in again. Nothing was sent. <button class="btn" onclick="openSignInAgain()">Sign in again</button></div>`;
}
function openSignInAgain() {
  signInState = { email: pageUser ? pageUser.email || '' : '', busy: false, message: '', again: true };
  showAuthOverlay(signInHtml());
}

function onAuthEvent(event, session) {
  if (!pageUser) return;
  if (session && session.user && session.user.id !== pageUser.id) { accountChanged(); return; }
  if (event === 'SIGNED_OUT') { accountChanged(); return; }
  if (session && session.user && session.user.id === pageUser.id && !authStopped) {
    const el = document.getElementById('phaseBanner');
    if (el && /Sign in again/.test(el.textContent || '')) el.innerHTML = '';
    if (signInState.again) { signInState = { email: '', busy: false, message: '' }; hideAuthOverlay(); }
  }
}

function reloadPage() { if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload(); }

// ── Sign-in screen (email and password; amendment A1) ──
// Accounts are created by the library owner (no public sign-up). A forgotten password is reset by the owner
// (docs/MEMBER_RECOVERY.md); no email is involved. Nothing typed here is stored or logged.
function signInHtml() {
  const s = signInState;
  const msg = s.message ? `<p class="auth-message" role="alert">${esc(s.message)}</p>` : '';
  return `<div class="modal-title" id="authTitle">${s.again ? 'Sign in again' : 'Sign in to Watchlist'}</div>
    <p class="settings-text">Only accounts the library owner created can sign in.</p>${msg}
    <form onsubmit="event.preventDefault(); submitSignIn()">
      <label class="auth-label" for="authEmail">Email</label>
      <input id="authEmail" class="auth-input" type="email" autocomplete="email" value="${esc(s.email)}" ${s.busy ? 'disabled' : ''}>
      <label class="auth-label" for="authPassword">Password</label>
      <input id="authPassword" class="auth-input" type="password" autocomplete="current-password" ${s.busy ? 'disabled' : ''}>
      <div class="modal-actions"><button class="btn btn-accent" type="submit" ${s.busy ? 'disabled' : ''}>${s.busy ? 'Signing in…' : 'Sign in'}</button></div>
    </form>
    <p class="settings-text auth-help">Forgot your password? Ask the library owner to reset it.</p>`;
}
function renderSignIn() {
  if (signInState.again || pageUser) { showAuthOverlay(signInHtml()); return; }
  const el = document.getElementById('authScreen');
  if (el) { el.innerHTML = `<div class="auth-box" role="dialog" aria-labelledby="authTitle">${signInHtml()}</div>`; focusFirstAuthInput(); }
}
function focusFirstAuthInput() {
  const el = document.getElementById(signInState.email ? 'authPassword' : 'authEmail');
  if (el && typeof el.focus === 'function') el.focus();
}
async function submitSignIn() {
  const emailEl = document.getElementById('authEmail'), pwEl = document.getElementById('authPassword');
  const email = String(emailEl ? emailEl.value : '').trim();
  const password = String(pwEl ? pwEl.value : '');
  if (pwEl) pwEl.value = '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) { signInState.email = email; signInState.message = 'Enter your email and password.'; renderSignIn(); return; }
  signInState = { ...signInState, email, busy: true, message: '' }; renderSignIn();
  let res = null;
  try { res = await authClient().auth.signInWithPassword({ email, password }); } catch (e) { res = { error: e }; }
  signInState.busy = false;
  if (!res || res.error || !res.data || !res.data.session) { signInState.message = signInErrorText(res && res.error); renderSignIn(); return; }
  if (pageUser && res.data.session.user.id !== pageUser.id) { accountChanged(); return; }
  if (pageUser) { onAuthEvent('SIGNED_IN', res.data.session); return; }
  signInState = { email: '', busy: false, message: '' };
  startSignedIn(res.data.session.user);
}
// One message for a wrong email or a wrong password (never which).
function signInErrorText(error) {
  const m = String(error && (error.message || error.code || error) || '');
  if (/rate|too many|security purposes|after \d+ seconds/i.test(m)) return 'Too many sign-in attempts just now. Wait a few minutes, then try again.';
  if (/fetch|network|failed to/i.test(m)) return 'The sign-in service couldn’t be reached. Check your connection and try again.';
  return 'That email and password didn’t match an account. Check them and try again, or ask the library owner to reset your password.';
}
function showAuthOverlay(html) {
  const o = document.getElementById('authModalOverlay'), b = document.getElementById('authModalBox');
  if (!o || !b) return;
  b.innerHTML = html; o.style.display = '';
  focusFirstAuthInput();
}
function hideAuthOverlay() { const o = document.getElementById('authModalOverlay'); if (o) o.style.display = 'none'; }

// ── Sign-out (Settings) ──
async function signOutHere() {
  if (writeLane) { if (typeof showError === 'function') showError(LANE_BUSY_TEXT(writeLane.label)); return; }
  const unknown = unknownOutcomesHere();
  if (unknown.length && !confirm('A change from this page got no answer, so it may or may not have been made. It won’t be sent again, and you’ll be warned again when you next sign in. Sign out anyway?')) return;
  authStopped = true;
  try { await authClient().auth.signOut({ scope: 'local' }); } catch (e) { /* the local session is removed either way */ }
  if (typeof resetRouteAfterSignOut === 'function') resetRouteAfterSignOut();
  reloadPage();
}
// An Auth answer counts as a confirmed refusal only when it is one of Auth's recognised refusals for that
// request (its error code); a network failure, a server error or anything unrecognised leaves the outcome
// unknown: the request may or may not have been carried out.
const AUTH_REFUSALS = {
  password: ['current_password_mismatch', 'current_password_required', 'weak_password', 'same_password', 'validation_failed', 'reauthentication_needed', 'session_not_found', 'user_not_found', 'not_admin', 'bad_jwt', 'no_authorization'],
  signOut: ['session_not_found', 'bad_jwt', 'no_authorization', 'validation_failed']
};
function authOutcome(error, kind) {
  if (!error) return 'done';
  const code = String(error.code || error.error_code || '');
  return AUTH_REFUSALS[kind].includes(code) ? 'refused' : 'unknown';
}
// Ends every other session of this account (other devices and browsers); this one stays signed in.
async function signOutOtherDevices() {
  let error = null;
  try { ({ error } = await authClient().auth.signOut({ scope: 'others' })); } catch (e) { error = e; }
  const o = authOutcome(error, 'signOut');
  setAccountNote(o === 'done' ? 'Every other device and browser signed in to this account has been signed out. Each can keep working only until its current access token expires (up to about an hour).'
    : o === 'refused' ? `Other devices weren’t signed out (${String(error.message || error.code)}). Sign in again here, then try again.`
    : 'There was no clear answer, so other devices may or may not have been signed out. Try again; signing out again is safe.');
}

// ── Change password (Settings) ──
// The current password is checked by Supabase Auth ("Require current password when updating", a project setting
// that must be on; the pinned client sends current_password as given). No email is involved.
let accountNote = '';
function setAccountNote(text) { accountNote = text; const el = document.getElementById('settingsAccountNote'); if (el) el.textContent = text; }
async function changePassword() {
  const get = id => { const el = document.getElementById(id); const v = el ? String(el.value) : ''; if (el) el.value = ''; return v; };
  const current = get('accountCurrentPassword'), next = get('accountNewPassword'), again = get('accountNewPassword2');
  if (!current || !next) { setAccountNote('Enter your current password and a new one.'); return; }
  if (next !== again) { setAccountNote('The two new passwords don’t match. Nothing was changed.'); return; }
  if (next.length < PASSWORD_MIN_LENGTH) { setAccountNote(`Use at least ${PASSWORD_MIN_LENGTH} characters. Nothing was changed.`); return; }
  if (!pageUser || authStopped) { setAccountNote(AUTH_NOT_SENT_TEXT); return; }
  setAccountNote('Changing…');
  let error = null;
  try { ({ error } = await authClient().auth.updateUser({ password: next, current_password: current })); } catch (e) { error = e; }
  const o = authOutcome(error, 'password');
  if (o === 'refused') {
    const code = String(error.code || error.error_code || ''), m = String(error.message || code);
    setAccountNote(/^current_password/.test(code) ? 'Your current password isn’t right. Nothing was changed.'
      : /weak_password|same_password|validation_failed/.test(code) ? `That password isn’t accepted (${m}). Nothing was changed.`
      : `The password wasn’t changed (${m}). Sign in again, then try again.`);
    return;
  }
  if (o === 'unknown') {
    // Never "not changed" without a recognised refusal: the change may have been made with its answer lost.
    setAccountNote('There was no clear answer, so your password may or may not have been changed. If you sign in again, try the new password first, then the old one; if neither works, ask the library owner to reset it. Neither password was kept.');
    return;
  }
  setAccountNote('Your password has been changed. Other devices stay signed in until you use “Sign out other devices”.');
}
const PASSWORD_MIN_LENGTH = 12;

function accountSectionHtml() {
  return `<section class="settings-card" aria-labelledby="settingsAccountTitle">
    <h3 id="settingsAccountTitle">Account</h3>
    <p class="settings-text">Signed in as <strong>${esc(pageUser ? pageUser.email || pageUser.id : '')}</strong>. This browser stays signed in until you sign out.</p>
    <div class="settings-actions"><button class="btn settings-signout" onclick="signOutHere()">Sign out on this device</button>
      <button class="btn settings-signout-others" onclick="signOutOtherDevices()">Sign out other devices</button></div>
    <div class="settings-sub">Change password</div>
    <form class="account-password" onsubmit="event.preventDefault(); changePassword()">
      <label class="auth-label" for="accountCurrentPassword">Current password</label>
      <input id="accountCurrentPassword" class="auth-input" type="password" autocomplete="current-password">
      <label class="auth-label" for="accountNewPassword">New password (at least ${PASSWORD_MIN_LENGTH} characters)</label>
      <input id="accountNewPassword" class="auth-input" type="password" autocomplete="new-password">
      <label class="auth-label" for="accountNewPassword2">New password again</label>
      <input id="accountNewPassword2" class="auth-input" type="password" autocomplete="new-password">
      <div class="settings-actions"><button class="btn" type="submit">Change password</button></div>
    </form>
    <p class="settings-text" id="settingsAccountNote" role="status">${esc(accountNote)}</p>
  </section>`;
}

function showNonMemberAccount() {
  setSignedOutMark(true);
  const el = document.getElementById('phaseBanner');
  if (el) el.innerHTML = `<div class="error-banner">⚠️ ${esc(NOT_A_MEMBER_TEXT)}</div>`;
  const screen = document.getElementById('authScreen');
  if (screen) screen.innerHTML = `<div class="auth-box auth-account">${accountSectionHtml()}</div>`;
  showLeftoverNotes();
}
// A change refused with not_a_member: the membership ended while this page was open. Nothing more is
// sent from it; a reload shows the account without a library.
function membershipEnded() {
  if (typeof b45Stopped !== 'undefined') { b45Stopped = true; stage5Phase = null; }
  const el = document.getElementById('phaseBanner');
  if (el) el.innerHTML = `<div class="error-banner">⚠️ ${esc(NOT_A_MEMBER_TEXT)} This page changes nothing more; reload it.</div>`;
}

function setSignedOutMark(on) {
  const body = typeof document !== 'undefined' && document.body;
  if (body && body.classList && typeof body.classList.toggle === 'function') body.classList.toggle('signed-out', on);
}

// ── Boot ──
// Restores the saved session, or shows the sign-in screen. The library is read only once a user
// is bound and the database confirms it is in the signed-in state (capability access = members).
async function bootAuth(start) {
  bootAuth.start = start;
  setSignedOutMark(true);
  try { authClient().auth.onAuthStateChange((event, session) => { setTimeout(() => onAuthEvent(event, session), 0); }); } catch (e) { /* no listener */ }
  let session = null;
  try { const { data } = await authClient().auth.getSession(); session = data ? data.session : null; } catch (e) { session = null; }
  if (session && session.user) startSignedIn(session.user);
  else renderSignIn();
}
async function startSignedIn(user) {
  pageUser = { id: user.id, email: user.email || '' };
  discardLegacyStorage();
  const screen = document.getElementById('authScreen');
  if (screen) screen.innerHTML = '';
  setSignedOutMark(false);
  let cap = null, failed = false;
  try { cap = await stage5Capabilities(); } catch (e) { failed = true; }
  if (!cap || cap.access !== 'members') {
    const el = document.getElementById('phaseBanner');
    if (el) el.innerHTML = `<div class="error-banner">⚠️ ${failed ? 'The database couldn’t be reached, so nothing is shown yet. Reload to try again.' : 'You’re signed in, but the database hasn’t been updated for signed-in libraries yet, so nothing is shown and nothing will be changed.'}</div>`;
    return;
  }
  // Signed in, but not a member now (never added, or membership disabled): no library is read, so nothing
  // empty is shown, backed up or written. The Account controls stay available (sign out, other devices,
  // password), which recovery uses.
  if (cap.member !== true) { showNonMemberAccount(); return; }
  showLeftoverNotes();
  if (typeof bootAuth.start === 'function') bootAuth.start(cap);
}
