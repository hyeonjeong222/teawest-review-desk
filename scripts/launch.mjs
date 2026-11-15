import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4317), url = `http://127.0.0.1:${port}`;
async function ready() { try { const response = await fetch(url + '/api/session', { signal: AbortSignal.timeout(1000) }); const session = await response.json(); return response.ok && typeof session.csrf === 'string'; } catch { return false; } }
if (!await ready()) {
  await access(path.join(root, 'node_modules/playwright-core'));
  await mkdir(path.join(root, '.local'), { recursive: true });
  const out = openSync(path.join(root, '.local/server.log'), 'a'), err = openSync(path.join(root, '.local/server-error.log'), 'a');
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.js'], { cwd: root, detached: true, stdio: ['ignore', out, err], windowsHide: true });
  child.unref(); closeSync(out); closeSync(err);
  let started = false;
  for (let i = 0; i < 30; i++) { await new Promise(resolve => setTimeout(resolve, 200)); if (await ready()) { started = true; break; } }
  if (!started) throw new Error('Review Desk did not start. Check .local/server-error.log.');
}
if (process.platform === 'win32') { const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }); browser.unref(); }
console.log(`Review Desk: ${url}`);
