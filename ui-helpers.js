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

function hasWatchableSoonSeason(seasons) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + WATCHABLE_SOON_DAYS);
  const cutoffStr = cutoff.toISOString().substring(0,10);
  return seasons.some(s => {
    if (s.watched || s.status === 'skipped') return false;
    if (/TBA/i.test(s.display_date)) return false;
    return s.date_sort <= cutoffStr;
  });
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

function formatDisplayDate(isoDate) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [y,m,d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  return `${months[m-1]} ${d}, ${y}`;
}
