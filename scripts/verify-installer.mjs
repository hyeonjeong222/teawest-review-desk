// Native Windows installation smoke test. Only synthetic credentials and temp folders.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { AuthVault } from '../src/auth-vault.js';
import { APIKeyVault } from '../src/api-key-vault.js';
import { Store } from '../src/core.js';

const run = promisify(execFile), installer = path.resolve(process.argv[2] || 'dist/installer-1.1.0/ReviewDesk-Setup-x64.exe');
const expectedVersion = JSON.parse(await readFile(path.join(path.dirname(installer), 'review-desk-update.json'), 'utf8')).version;
const root = await mkdtemp(path.join(os.tmpdir(), 'review-installer-test-'));
const legacy = path.join(root, 'legacy'), data = path.join(root, 'data'), port = 14329, origin = `http://127.0.0.1:${port}`;
let launched = false;
async function stop() {
  const session = await fetch(origin + '/api/session').then(r => r.json());
  const result = await fetch(origin + '/api/app/shutdown', { method: 'POST', headers: { 'content-type': 'application/json', Origin: origin, 'X-Review-Token': session.csrf }, body: '{"confirmed":true}' });
  assert.equal(result.status, 200); await result.json();
  for (let i = 0; i < 50; i++) { try { await fetch(origin + '/api/session'); } catch { return; } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Test server did not stop.');
}
try {
  // Never interrupt an unrelated process, even on the test port.
  let occupied = false; try { await fetch(origin + '/api/session', { signal: AbortSignal.timeout(1000) }); occupied = true; } catch {}
  assert.equal(occupied, false, 'Test port is already in use.');
  await mkdir(path.join(legacy, '.local'), { recursive: true });
  await writeFile(path.join(legacy, 'package.json'), '{"name":"teawest-review-desk","version":"1.0.0"}');
  const store = new Store(path.join(legacy, '.local')); await store.init();
  await store.update(state => { state.autoSync.enabled = false; state.reviews = [{ id: 'fixture', platform: 'naver', store: 'synthetic-test-store', product: 'synthetic product', content: 'synthetic review', rating: 5, hasReply: false }]; state.drafts.fixture = { text: 'keep the local draft' }; });
  const names = [];
  for (const provider of ['naver', 'coupang', 'ably', 'baemin', 'coupangeats']) {
    const vault = new AuthVault(path.join(legacy, '.local'), undefined, { platform: provider }); await vault.init();
    await vault.save({ enabled: false, username: 'synthetic-test-user', password: 'synthetic-test-password', method: provider }); names.push(`${provider}-auth.json`);
  }
  const ai = { configured: false, configure() { this.configured = true; } };
  const key = new APIKeyVault(path.join(legacy, '.local'), ai); await key.save('sk-synthetic-test-key-not-a-real-key'); names.push('openai-key.json', 'state.json');
  for (const file of ['inquiries.json', 'coupang-inquiries.json', 'ably-inquiries.json']) {
    await writeFile(path.join(legacy, '.local', file), JSON.stringify({ version: 1, records: {}, drafts: { fixture: { text: 'keep the inquiry draft' } }, attempts: {}, completions: {} })); names.push(file);
  }
  const original = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(path.join(legacy, '.local', name))])));
  const install = () => run(installer, ['--test-install', root, '--legacy', legacy, '--port', String(port)], { windowsHide: true, timeout: 180000 });
  console.log('Installing into an isolated temp folder and migrating synthetic credentials…');
  await install();
  for (const name of names) { assert.deepEqual(await readFile(path.join(data, name)), original[name]); assert.deepEqual(await readFile(path.join(legacy, '.local', name)), original[name]); }
  await access(path.join(root, 'test-desktop', '리뷰 관리.lnk')); await access(path.join(root, 'test-menu', '리뷰 관리.lnk'));
  const current = JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8')); assert.equal(current.version, expectedVersion);
  console.log('Starting through the native desktop launcher…');
  const launcher = spawn(path.join(root, 'ReviewDesk.exe'), [], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, REVIEW_DESK_NO_BROWSER: '1', NAVER_CDP_URL: 'http://127.0.0.1:19339' } });
  launched = true;
  const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => { launcher.kill(); reject(new Error('Launcher timeout')); }, 45000); launcher.once('error', reject); launcher.once('exit', code => { clearTimeout(timer); resolve(code); }); }); assert.equal(result, 0);
  const session = await fetch(origin + '/api/session').then(r => r.json()); assert.equal(session.aiConfigured, true); assert.equal(session.aiKey.saved, true); assert.equal(session.app.installed, true);
  assert.equal(session.app.version, expectedVersion); assert.equal(session.capabilities.inquiryAlerts, true);
  assert.match(await fetch(origin + '/').then(r => r.text()), /id="inquiry-alerts"/);
  assert.match(await fetch(origin + '/inquiry-alerts.js').then(r => r.text()), /export function createInquiryAlerts/);
  assert.match(await fetch(origin + '/app.js').then(r => r.text()), /id="refine-button"/);
  assert.match(await fetch(origin + '/inquiries.js').then(r => r.text()), /id="inbox-refine"/);
  // Empty text must reach the packaged refinement validator, without calling GPT or saving a draft.
  const refinement = await fetch(origin + '/api/reviews/fixture/refine', { method: 'POST', headers: { 'content-type': 'application/json', Origin: origin, 'X-Review-Token': session.csrf }, body: '{"text":""}' });
  assert.equal(refinement.status, 400); assert.equal((await refinement.json()).code, 'INVALID_REFINEMENT_DRAFT');
  const info = await fetch(origin + '/api/app/info').then(r => r.json()); assert.equal(info.dataDirectory.toLowerCase(), data.toLowerCase());
  // Simulate updating a previous installed version while it is running.
  await writeFile(path.join(root, 'current.json'), JSON.stringify({ ...current, version: '1.0.0' }));
  console.log('Updating while the test app is running…');
  await install(); launched = false;
  for (const name of names) assert.deepEqual(await readFile(path.join(data, name)), original[name]);
  assert.equal(JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8')).version, expectedVersion);
  for (const provider of ['naver', 'coupang', 'ably', 'baemin', 'coupangeats']) {
    const vault = new AuthVault(data, undefined, { platform: provider }); await vault.init(); assert.equal((await vault.decryptCredentials()).username, 'synthetic-test-user');
  }
  await writeFile(path.join(root, 'current.json'), JSON.stringify({ ...current, version: '9.0.0' }));
  await assert.rejects(install()); assert.equal(JSON.parse(await readFile(path.join(root, 'current.json'), 'utf8')).version, '9.0.0');
  console.log(JSON.stringify({ installed: true, desktopShortcut: true, startMenuShortcut: true, nativeLauncher: true, samePCMigration: true, encryptedAccountsPreserved: 5, apiKeyPreserved: true, draftsPreserved: true, inquiryFilesPreserved: 3, inquiryAlertsAvailable: true, draftRefinementAvailable: true, gracefulRestart: true, downgradeRejected: true }));
} catch (error) {
  let detail; try { detail = await readFile(path.join(root, 'test-error.txt'), 'utf8'); } catch {}
  if (detail) console.error(detail);
  throw error;
} finally {
  if (launched) await stop().catch(() => {});
  const resolved = path.resolve(root), temp = path.resolve(os.tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('review-installer-test-')) throw new Error('Unexpected test directory');
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
