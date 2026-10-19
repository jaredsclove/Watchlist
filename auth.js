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
const PENDING_NOTES_KEY = 'watchlist_pending_writes';
// Remembered settings from before sign-in existed: not tied to any account, so discarded (plan D9).
const LEGACY_STORAGE_KEYS = ['watchlist_last_backup_at', 'watchlist_last_collection', 'watchlist_alltv_presentation'];
const LEGACY_STORAGE_PREFIXES = ['watchlist_browse_layout_'];

let authClientInstance = null;
let pageUser = null; // { id, email }: the account this page was loaded for; null until bound
let authStopped = false; // an account change or sign-out: nothing more is sent from this page
let authAckPending = false; // the account changed while an outcome was unknown: waiting for "I understand"
let pageNotes = new Set(); // ids of the pending notes this page wrote and hasn't seen answered
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
function readNotes() {
  try { const v = JSON.parse(userStorage.getItem(PENDING_NOTES_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
}
function writeNotes(notes) {
  try {
    if (Object.keys(notes).length) userStorage.setItem(PENDING_NOTES_KEY, JSON.stringify(notes)); else userStorage.removeItem(PENDING_NOTES_KEY);
    return true;
  } catch (e) { return false; }
}
let notesUnavailableShown = false;
// Saved immediately before a write is sent. Returns its id.
function savePendingNote(what, extra = {}) {
  const id = `${Date.now().toString(36)}-${(++pageNoteSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const notes = readNotes();
  notes[id] = { what: String(what || 'A change'), at: new Date().toISOString(), ...extra };
  if (!writeNotes(notes) && !notesUnavailableShown) {
    notesUnavailableShown = true;
    if (typeof showError === 'function') showError('This browser isn’t keeping notes about changes in progress, so if this page closes while a change is out, it can’t warn you about it later.');
  }
  pageNotes.add(id);
  return id;
}
// A confirmed answer (done or refused) for that request: its note goes. Only the page that
// wrote a note clears it, by its id.
function clearPendingNote(id) {
  if (!id) return;
  pageNotes.delete(id);
  const notes = readNotes();
  if (notes[id]) { delete notes[id]; writeNotes(notes); }
}
// No answer: the note stays (shown again at the next load) and this page keeps it as unknown.
function keepPendingNote(id) { if (id) pageNotes.add(id); }
function unknownOutcomesHere() { const notes = readNotes(); return [...pageNotes].filter(id => notes[id]); }

// The notes left from earlier pages (the outcome of those changes is unknown).
function showLeftoverNotes() {
  const el = document.getElementById('unknownBanner');
  if (!el) return;
  const notes = readNotes();
  const ids = Object.keys(notes).filter(id => !pageNotes.has(id));
  if (!ids.length) { el.innerHTML = ''; return; }
  const items = ids.sort((a, b) => String(notes[a].at).localeCompare(String(notes[b].at)))
    .map(id => `<li>${esc(notes[id].what)} <span class="unknown-when">(${esc(formatNoteTime(notes[id].at))})</span>${notes[id].safetyBackup ? `<br>Safety backup taken before it: ${esc(notes[id].safetyBackup)}` : ''}</li>`).join('');
  el.innerHTML = `<div class="error-banner unknown-banner" role="alert">⚠️ ${ids.length === 1 ? 'A change' : `${ids.length} changes`} sent earlier from this browser got no answer, so ${ids.length === 1 ? 'it' : 'each'} may or may not have been made:
    <ul>${items}</ul>Check what is saved now. Nothing was sent again.
    <button class="btn" onclick="dismissLeftoverNotes()">I’ve checked — dismiss</button></div>`;
}
function dismissLeftoverNotes() {
  const notes = readNotes();
  Object.keys(notes).filter(id => !pageNotes.has(id)).forEach(id => delete notes[id]);
  writeNotes(notes);
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
  const notes = readNotes();
  const items = unknownOutcomesHere().map(id => `<li>${esc(notes[id].what)}${notes[id].safetyBackup ? ` (safety backup: ${esc(notes[id].safetyBackup)})` : ''}</li>`).join('');
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
// Ends every other session of this account (other devices and browsers); this one stays signed in.
async function signOutOtherDevices() {
  let error = null;
  try { ({ error } = await authClient().auth.signOut({ scope: 'others' })); } catch (e) { error = e; }
  setAccountNote(error ? `Other devices couldn’t be signed out (${String(error.message || error)}). Try again.`
    : 'Every other device and browser signed in to this account has been signed out. Each can keep working only until its current access token expires (up to about an hour).');
}

// ── Change password (Settings) ──
// The current password is checked twice: by Supabase Auth when its "require current password" setting is on
// (always sent), and here, by a separate sign-in that is never saved and is signed out at once.
let accountNote = '';
function setAccountNote(text) { accountNote = text; const el = document.getElementById('settingsAccountNote'); if (el) el.textContent = text; }
async function changePassword() {
  const get = id => { const el = document.getElementById(id); const v = el ? String(el.value) : ''; if (el) el.value = ''; return v; };
  const current = get('accountCurrentPassword'), next = get('accountNewPassword'), again = get('accountNewPassword2');
  if (!current || !next) { setAccountNote('Enter your current password and a new one.'); return; }
  if (next !== again) { setAccountNote('The two new passwords don’t match. Nothing was changed.'); return; }
  if (next.length < PASSWORD_MIN_LENGTH) { setAccountNote(`Use at least ${PASSWORD_MIN_LENGTH} characters. Nothing was changed.`); return; }
  if (!pageUser || authStopped) { setAccountNote(AUTH_NOT_SENT_TEXT); return; }
  setAccountNote('Checking…');
  if (!(await currentPasswordIsRight(current))) { setAccountNote('Your current password isn’t right. Nothing was changed.'); return; }
  let error = null;
  try { ({ error } = await authClient().auth.updateUser({ password: next, current_password: current })); } catch (e) { error = e; }
  if (error) {
    const m = String(error.message || error.code || error);
    setAccountNote(/current password/i.test(m) ? 'Your current password isn’t right. Nothing was changed.'
      : /weak|short|characters/i.test(m) ? `That password isn’t accepted (${m}). Nothing was changed.`
      : `The password wasn’t changed (${m}).`);
    return;
  }
  setAccountNote('Your password has been changed. Other devices stay signed in until you use “Sign out other devices”.');
}
async function currentPasswordIsRight(current) {
  try {
    const probe = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'watchlist-password-check' } });
    const { data, error } = await probe.auth.signInWithPassword({ email: pageUser.email, password: current });
    const ok = !error && data && data.session && data.session.user && data.session.user.id === pageUser.id;
    if (data && data.session) { try { await probe.auth.signOut({ scope: 'local' }); } catch (e) { /* that check session ends at its expiry anyway */ } }
    return !!ok;
  } catch (e) { return false; }
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
  showLeftoverNotes();
  if (typeof bootAuth.start === 'function') bootAuth.start(cap);
}
