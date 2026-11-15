import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { ReplyAI } from '../src/ai.js';
import { APIKeyVault } from '../src/api-key-vault.js';
import { cleanupTestDirectory } from './cleanup.js';

test('API key survives server restart encrypted, stays out of responses, and deletion survives environment fallback', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-'));
  let running;
  const close = async () => { if (!running) return; running.server.closeAllConnections(); await new Promise(resolve => running.server.close(resolve)); running = null; };
  t.after(async () => { await close(); await cleanupTestDirectory(directory); });
  const base = 'http://127.0.0.1:14319';
  const start = async (environmentKey = '') => {
    const ai = new ReplyAI(environmentKey);
    const connector = { status: async () => ({ connected: true }), publish: () => assert.fail('Key management must not publish') };
    running = await createApp({ directory, ablyConnector: { status: async () => ({ connected: false }), sync: async () => ({ reviews: [], total: 0 }) }, connector, coupangConnector: { status: async () => ({ connected: false }) }, ai, port: 14319, maintenanceInterval: 0 });
    running.server.listen(14319, '127.0.0.1'); await once(running.server, 'listening'); return ai;
  };
  const post = (data, token = running.csrf) => fetch(base + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Review-Token': token }, body: JSON.stringify(data) });
  const secret = 'sk-synthetic-persisted-test-key', replacement = 'sk-synthetic-replacement-test-key';
  await start();
  assert.equal((await post({ apiKey: secret }, 'wrong')).status, 403);
  const saved = await post({ apiKey: secret }).then(r => r.json()); assert.equal(saved.aiKey.saved, true); assert.equal(saved.aiConfigured, true);
  const file = path.join(directory, 'openai-key.json'); const encrypted = await readFile(file, 'utf8');
  assert.equal(encrypted.includes(secret), false); assert.equal(encrypted.includes(Buffer.from(secret).toString('base64')), false);
  assert.ok(JSON.parse(encrypted).encrypted);
  for (const route of ['/api/session', '/api/status', '/api/reviews']) {
    const response = await fetch(base + route).then(r => r.text()); assert.equal(response.includes(secret), false); assert.equal(response.includes(JSON.parse(encrypted).encrypted), false);
  }
  assert.equal((await readFile(path.join(directory, 'state.json'), 'utf8')).includes(secret), false);
  assert.equal((await fetch(base + '/.local/openai-key.json')).status, 404);
  await close(); const restored = await start('sk-unrelated-environment-test-key');
  assert.equal(restored.key, secret); const session = await fetch(base + '/api/session').then(r => r.json()); assert.equal(session.aiKey.source, 'saved'); assert.equal(session.aiConfigured, true);
  for (const apiKey of ['invalid-key', {}, 'sk-key with spaces']) assert.equal((await post({ apiKey })).status, 400);
  assert.equal(restored.key, secret); assert.equal(await readFile(file, 'utf8'), encrypted);
  await post({ apiKey: '', tone: '간결하고 담백하게' }); assert.equal(restored.key, secret);
  assert.equal((await post({ apiKey: replacement })).status, 200); await close(); assert.equal((await start()).key, replacement);
  assert.equal((await post({ disconnectAI: true }, 'wrong')).status, 403);
  const forgotten = await post({ disconnectAI: true }).then(r => r.json()); assert.equal(forgotten.aiConfigured, false); assert.equal(forgotten.aiKey.saved, false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).encrypted, null);
  await close(); const deleted = await start('sk-unrelated-environment-test-key'); assert.equal(deleted.configured, false);
});

test('failed encryption preserves an existing key and reports no secret material', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')); t.after(() => cleanupTestDirectory(directory));
  const ai = new ReplyAI('sk-existing-test-key');
  const vault = new APIKeyVault(directory, ai, async () => { throw new Error('private material must never reach a response'); });
  await assert.rejects(vault.save('sk-new-test-key'), e => e.code === 'API_KEY_STORAGE' && !e.message.includes('private material'));
  assert.equal(ai.key, 'sk-existing-test-key'); await assert.rejects(readFile(vault.file), { code: 'ENOENT' });
});

test('unreadable stored key disables AI without crashing the app and can be removed', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')); t.after(() => cleanupTestDirectory(directory));
  const ai = new ReplyAI('sk-environment-test-key'); const vault = new APIKeyVault(directory, ai, async () => { throw new Error('Wrong Windows account'); });
  await writeFile(vault.file, JSON.stringify({ version: 1, encrypted: 'ciphertext-from-another-user' }));
  await vault.init(); assert.equal(ai.configured, false); assert.equal(vault.publicState().storageError, true);
  await vault.forget(); assert.equal(vault.publicState().storageError, false); assert.equal(vault.publicState().saved, false);
});
