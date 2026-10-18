// ─── One write at a time (simplification Batch A) ─────────────────────────────
// The page makes one change at a time. A change takes the write lane before it shows
// or sends anything and keeps it until its answer and the reread that reconciles it
// have finished. While the lane is held the list's controls are shown as unavailable
// (body.saving, list aria-busy) and any other change is refused before anything is
// shown or sent. Navigation and reads stay available.
//
// Reads: dataVersion moves on when a change takes the lane, whenever it sends a request
// and whenever that request is answered or fails (api.js sbFetch). From taking the lane
// until its first request settles, the change counts as a pending write (its optimistic
// redraw and any capability check come before it sends). A read keeps the version it
// started with (readStamp) and may publish only while that version is still current and
// no change is pending or waiting for its answer (readFresh). So a read that started before or during a write never shows its
// older data, during the write or after it. Each reader also keeps its own "newest
// started wins" number and its view check. A reader whose read was refused this way
// reads again once the lane is free (readAgainWhenFree).
//
// Unconfirmed changes (no clear answer) are reported as not confirmed, never resent,
// and the list is read again; a fresh read doesn't prove the change has (or hasn't)
// finished on the server.
//
// A reread after a change that fails leaves the list on screen, marked out of date
// (listStale). Changes from the list are refused until a read of it succeeds (Retry),
// so no change is based on a list that may be wrong.
let writeLane = null; // { label, after: [] } while a change is in progress
let dataVersion = 0;
let writesInFlight = 0;
let listStale = false;
let listRereading = false; // the open list is being read again in place (derived-views.js beginListReread)

const LANE_BUSY_TEXT = label => `${label} is still being saved. Nothing else was changed; try again when it has finished.`;
const LIST_STALE_TEXT = 'The list couldn’t be read again, so it may be out of date and nothing was changed. Use Retry to read it again first.';

// Takes the lane, or refuses (null) with a message. opts.list: a change made from the
// open list, refused while that list is out of date.
function beginWrite(label, opts = {}) {
  if (writeLane) { laneRefused(LANE_BUSY_TEXT(writeLane.label), opts); return null; }
  if (opts.list && listStale) { laneRefused(LIST_STALE_TEXT, opts); return null; }
  writeLane = { label, after: [], held: true };
  writesInFlight++; dataVersion++; // pending from now: no read that overlaps the change publishes
  setSavingMark(true);
  if (typeof updateLeaveWarning === 'function') updateLeaveWarning(); // S6 (D18)
  return writeLane;
}

// The hold ends with the change's first answer (writeSettled) or with the lane, so the
// reread that reconciles it can publish.
function releaseLaneHold(lane) {
  if (!lane || !lane.held) return;
  lane.held = false;
  writesInFlight = Math.max(0, writesInFlight - 1);
  dataVersion++;
}

function endWrite(lane) {
  if (!lane || writeLane !== lane) return;
  releaseLaneHold(lane);
  writeLane = null;
  setSavingMark(false);
  if (typeof updateLeaveWarning === 'function') updateLeaveWarning(); // S6 (D18)
  lane.after.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
}

// Runs fn(lane) holding the lane; undefined when refused.
async function runWrite(label, fn, opts) {
  const lane = beginWrite(label, opts);
  if (!lane) return undefined;
  try { return await fn(lane); } finally { endWrite(lane); }
}

function laneRefused(text, opts) {
  if (typeof showError === 'function') showError(text);
  // A select or checkbox the owner just changed goes back to what is saved.
  if (opts && opts.list && typeof renderTable === 'function') renderTable();
}

function setSavingMark(on) {
  if (typeof document === 'undefined') return;
  const body = document.body;
  if (body && body.classList && typeof body.classList.toggle === 'function') body.classList.toggle('saving', on);
  updateListBusy();
}

// The list is busy while a change is saved or while it is read again in place.
function updateListBusy() {
  if (typeof document === 'undefined') return;
  const busy = !!writeLane || listRereading;
  ['tbody', 'cardList'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (busy && typeof el.setAttribute === 'function') el.setAttribute('aria-busy', 'true');
    else if (!busy && typeof el.removeAttribute === 'function') el.removeAttribute('aria-busy');
  });
}

// ── Reads ──
function readStamp() {
  return { version: dataVersion };
}

function readFresh(stamp) {
  return !!stamp && stamp.version === dataVersion && writesInFlight === 0;
}

// Called by api.js around every request that changes data.
function writeSent() { writesInFlight++; dataVersion++; }
function writeSettled() { writesInFlight = Math.max(0, writesInFlight - 1); dataVersion++; releaseLaneHold(writeLane); }

// A read refused because a change overlapped it: read again once the lane is free.
// fn checks for itself that it is still wanted (the same view, no newer read).
function readAgainWhenFree(fn) {
  if (writeLane) writeLane.after.push(fn);
  else Promise.resolve().then(fn);
}
