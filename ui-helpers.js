// Hardcoded network colors; unknown networks fall back to a hashed color.
function networkColor(name) {
  if (NETWORK_COLORS[name]) return NETWORK_COLORS[name];
  // simple deterministic hash -> hex color (must be hex, not hsl, so alpha-suffix works in networkBadgeStyle)
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return hslToHex(hue, 55, 55);
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2*l - 1)) * s;
  const x = c * (1 - Math.abs((h/60) % 2 - 1));
  const m = l - c/2;
  let r=0, g=0, b=0;
  if (h < 60)       { r=c; g=x; b=0; }
  else if (h < 120) { r=x; g=c; b=0; }
  else if (h < 180) { r=0; g=c; b=x; }
  else if (h < 240) { r=0; g=x; b=c; }
  else if (h < 300) { r=x; g=0; b=c; }
  else              { r=c; g=0; b=x; }
  const toHex = v => Math.round((v+m)*255).toString(16).padStart(2,'0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function isLightMode() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
}
function networkBadgeStyle(name) {
  const color = networkColor(name);
  if (isLightMode()) {
    // light mode: darken the text color for contrast on white, use a much lighter
    // background tint (higher opacity of a pale mix) instead of the near-transparent
    // dark-mode wash, which would be nearly invisible on a white page
    const darkened = darkenHex(color, 0.35);
    return `style="background:${color}1a; color:${darkened}; border-color:${color}66"`;
  }
  return `style="background:${color}22; color:${color}; border-color:${color}55"`;
}
// A network category chip (render.js): the network's colour (or the hashed fallback) as the
// tinted background and border, like networkBadgeStyle, with the text colour moved toward white
// (dark) or darkened (light) until it reads at 4.5:1 over the chip on the page's surfaces.
// Chosen at render time, like networkBadgeStyle. Original-label badges keep networkBadgeStyle.
const CHIP_SURFACES = { dark: ['#0d0f14', '#161a23', '#1e2330'], light: ['#f5f6f8', '#ffffff'] };
function chipRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function chipLuminance(c) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function chipContrast(a, b) { const x = chipLuminance(a), y = chipLuminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
function networkChipStyle(name) {
  const color = networkColor(name), c = chipRgb(color), light = isLightMode();
  const alpha = light ? 0x1a / 255 : 0x22 / 255;
  const surfaces = (light ? CHIP_SURFACES.light : CHIP_SURFACES.dark).map(chipRgb);
  const worst = t => Math.min(...surfaces.map(s => chipContrast(t, c.map((v, i) => Math.round(v * alpha + s[i] * (1 - alpha))))));
  let t = light ? chipRgb(darkenHex(color, 0.35)) : c.slice();
  for (let i = 0; i < 40 && worst(t) < 4.5; i++) t = light ? t.map(v => Math.round(v * 0.92)) : t.map(v => Math.round(v + (255 - v) * 0.08));
  const text = '#' + t.map(v => v.toString(16).padStart(2, '0')).join('');
  return light ? `style="background:${color}1a; color:${text}; border-color:${color}66"`
    : `style="background:${color}22; color:${text}; border-color:${color}55"`;
}
function darkenHex(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r * (1 - amount));
  g = Math.round(g * (1 - amount));
  b = Math.round(b * (1 - amount));
  const toHex = v => v.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function badgeClass(theme) {
  return 'b-' + theme.replace(/\s/g,'').replace(/[^a-zA-Z0-9]/g,'');
}
function esc(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function parseDate(d) {
  const mo = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
  const m = d.match(/(\w+)\s+(\d+),?\s+(\d{4})/);
  if (m) return `${m[3]}-${mo[m[1]]||'01'}-${m[2].padStart(2,'0')}`;
  const y = d.match(/(\d{4})/);
  return y ? `${y[1]}-06-01` : '2025-01-01';
}
function showSaved() {
  const el = document.getElementById('saveStatus');
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2000);
}
function showError(msg) {
  document.getElementById('errorBanner').innerHTML = msg
    ? `<div class="error-banner">⚠️ ${esc(msg)}</div>` : '';
}

// ─── TMDB lookup failures ─────────────────────────────────────────────────────
// Refresh and pull flows look items up on TMDB one at a time. Callers collect the
// names whose lookup failed, so an outage is never reported as "nothing new" and a
// partial add is never reported as a plain success.
function tmdbNameList(names) {
  return names.length <= 5 ? names.join(', ') : `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`;
}

// For a preview built from `attempted` lookups: null if none failed, otherwise
// { total, message } — total means nothing could be checked at all.
function tmdbLookupFailureNote(attempted, failedNames, noun) {
  const failed = failedNames.length;
  if (failed === 0) return null;
  if (failed >= attempted) {
    return { total: true, message: `Couldn't check TMDB right now. ${failed} of ${attempted} ${noun} lookup${attempted === 1 ? '' : 's'} failed. Nothing was changed.` };
  }
  return { total: false, message: `Checked ${attempted - failed} of ${attempted} ${noun}s. ${failed} TMDB lookup${failed === 1 ? '' : 's'} failed (${tmdbNameList(failedNames)}), so this result may be incomplete.` };
}

// For adding `selected` items whose TMDB details are fetched one by one: null if
// none failed, otherwise the message to show.
function tmdbAddFailureNote(selected, failedNames, noun) {
  const failed = failedNames.length;
  if (failed === 0) return null;
  if (failed >= selected) {
    return `Couldn't load TMDB details for ${selected === 1 ? `the selected ${noun}` : `any of the ${selected} selected ${noun}s`}, so nothing was added. Try again in a moment.`;
  }
  return `Added ${selected - failed} of ${selected} selected ${noun}s. Couldn't load TMDB details for ${tmdbNameList(failedNames)}, so ${failed === 1 ? 'it was' : 'they were'} not added.`;
}

function formatDisplayDate(isoDate) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [y,m,d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  return `${months[m-1]} ${d}, ${y}`;
}

// ─── Dialogs: keyboard and focus ──────────────────────────────────────────────
// One dialog's keydown: Escape asks it to close (onEscape keeps that dialog's own rules: a busy
// dialog refuses), and Tab / Shift+Tab stay inside the box, wrapping from the last control to the
// first and back (Shift+Tab from the box itself goes to the last). selector: the controls that
// take part; a disabled or hidden one is skipped.
function dialogKeydown(event, box, selector, onEscape) {
  if (event.key === 'Escape') { if (typeof event.preventDefault === 'function') event.preventDefault(); onEscape(); return; }
  if (event.key !== 'Tab' || !box) return;
  const items = [...box.querySelectorAll(selector)].filter(el => !el.disabled && el.offsetParent !== null);
  if (!items.length) { event.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === box)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

// After a dialog closes: focus goes back to the control that opened it if that is still in the
// page, else to fallback() (its redrawn equivalent, or another sensible control), never the page.
function returnDialogFocus(opener, fallback) {
  const back = opener && opener.isConnected !== false ? opener : (fallback ? fallback() : null);
  if (back && typeof back.focus === 'function') back.focus();
  return back;
}
