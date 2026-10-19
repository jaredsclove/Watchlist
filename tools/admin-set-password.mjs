// Owner-assisted password reset (docs/MEMBER_RECOVERY.md). Run by the library owner in their own terminal;
// it is never run with real credentials on anyone else's behalf.
//   node tools/admin-set-password.mjs --project <project ref, or local> --user <the member's Auth user id>
// It asks, at hidden prompts, for a secret API key (create a temporary one in the dashboard for this, and delete it
// afterwards) and the new password (twice). Nothing typed is echoed, printed, logged or stored. It calls the Auth
// admin API (update user by id: password) on that project only, and then prints the remaining recovery steps.
// Without a terminal (a test harness), it reads the three values from standard input, one per line.
import readline from 'readline';

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const project = opt('--project'), user = opt('--user');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (!project || !(project === 'local' || /^[a-z0-9]{20}$/.test(project)) || !UUID.test(user || '')) {
  console.error('usage: node tools/admin-set-password.mjs --project <20-character project ref, or local> --user <Auth user id>');
  process.exit(2);
}
const base = project === 'local' ? 'http://127.0.0.1:54321' : `https://${project}.supabase.co`;

async function ask(prompts) {
  if (!process.stdin.isTTY) {
    const lines = []; const rl = readline.createInterface({ input: process.stdin });
    for await (const l of rl) { lines.push(l); if (lines.length === prompts.length) break; }
    rl.close();
    return lines;
  }
  const out = [];
  for (const p of prompts) {
    out.push(await new Promise(resolve => {
      process.stdout.write(p);
      const stdin = process.stdin; let v = '';
      stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
      const onData = ch => {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); resolve(v); }
        else if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        else if (ch === '\u007f') v = v.slice(0, -1);
        else v += ch;
      };
      stdin.on('data', onData);
    }));
  }
  return out;
}

const [key, pw1, pw2] = await ask(['Secret API key (hidden): ', 'New password (hidden): ', 'New password again (hidden): ']);
if (!key || !/^(sb_secret_|eyJ)/.test(key.trim())) { console.error('That isn’t a secret API key. Nothing was changed.'); process.exit(1); }
if (!pw1 || pw1 !== pw2) { console.error('The two passwords don’t match. Nothing was changed.'); process.exit(1); }
if (pw1.length < 12) { console.error('Use at least 12 characters. Nothing was changed.'); process.exit(1); }
const headers = { apikey: key.trim(), Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' };
const res = await fetch(`${base}/auth/v1/admin/users/${user}`, { method: 'PUT', headers, body: JSON.stringify({ password: pw1 }) });
const text = await res.text();
let body = null; try { body = JSON.parse(text); } catch (e) { body = null; }
if (!res.ok) {
  const msg = body && (body.msg || body.message || body.error_description || body.error) || `HTTP ${res.status}`;
  console.error(`The password was not changed: ${String(msg).slice(0, 200)}`);
  process.exit(1);
}
console.log(`Password set for ${body && body.email ? body.email : user} on ${project === 'local' ? 'the local stack' : `project …${project.slice(-4)}`}.`);
console.log('Next (docs/MEMBER_RECOVERY.md): if this was a lost device or a leaked password, keep the membership disabled,');
console.log('sign in with the new password on a trusted device and use “Sign out other devices”, check the old session fails,');
console.log('wait the access-token lifetime plus 5 minutes, then restore the membership. Delete the temporary secret key now.');
