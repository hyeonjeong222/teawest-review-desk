import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dataDirectory } from '../src/data-directory.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4317), url = `http://127.0.0.1:${port}`;
async function ready() {
  let response, session;
  try { response = await fetch(url + '/api/session', { signal: AbortSignal.timeout(1000) }); session = await response.json(); } catch { return false; }
  if (!response.ok || typeof session.csrf !== 'string') throw new Error('Another application is using the local app address.');
  if (process.env.REVIEW_DESK_INSTALLED === '1') {
    const info = await fetch(url + '/api/app/info', { signal: AbortSignal.timeout(1000) }).then(r => r.json()).catch(() => null);
    if (!info?.installed || path.resolve(info.root).toLowerCase() !== root.toLowerCase() || path.resolve(info.dataDirectory).toLowerCase() !== dataDirectory().toLowerCase()) throw new Error('A different Review Desk installation is running. Run the installer to switch safely.');
  }
  return true;
}
if (!await ready()) {
  await access(path.join(root, 'node_modules/playwright-core'));
  const data = dataDirectory(); await mkdir(data, { recursive: true });
  const out = openSync(path.join(data, 'server.log'), 'a'), err = openSync(path.join(data, 'server-error.log'), 'a');
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', path.join(root, 'src/server.js')], { cwd: root, detached: true, stdio: ['ignore', out, err], windowsHide: true });
  child.unref(); closeSync(out); closeSync(err);
  let started = false;
  const deadline = Date.now() + 28000;
  while (Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 200)); if (await ready()) { started = true; break; } }
  if (!started) throw new Error('Review Desk did not start. Check server-error.log in the app data folder.');
}
if (process.platform === 'win32' && process.env.REVIEW_DESK_NO_BROWSER !== '1') { const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }); browser.unref(); }
console.log(`Review Desk: ${url}`);
