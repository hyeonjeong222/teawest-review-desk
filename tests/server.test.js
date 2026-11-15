import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { cleanupTestDirectory } from './cleanup.js';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { fingerprint } from '../src/core.js';
test('installer shutdown is CSRF protected, rejects new writes, and drains active work before closing', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-'));
  const port = 14328, origin = `http://127.0.0.1:${port}`;
  const app = await createApp({ directory, port, maintenanceInterval: 0, connector: { status: async () => ({ connected: false }) } });
  t.after(async () => { app.server.closeAllConnections(); if (app.server.listening) await new Promise(r => app.server.close(r)); await cleanupTestDirectory(directory); });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const post = (route, data, token = app.csrf) => fetch(origin + route, { method: 'POST', headers: { 'content-type': 'application/json', Origin: origin, 'X-Review-Token': token }, body: JSON.stringify(data) });
  assert.equal((await post('/api/app/shutdown', { confirmed: true }, 'bad')).status, 403);
  assert.equal((await post('/api/app/shutdown', { confirmed: false })).status, 400);
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const writing = app.service.queue.run(async () => { await pending; await app.store.update(state => { state.drafts.final = { text: 'saved before shutdown' }; }); });
  const shutdown = post('/api/app/shutdown', { confirmed: true });
  for (let i = 0; i < 30; i++) { if ((await fetch(origin + '/api/app/info').then(r => r.json())).shuttingDown) break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal((await post('/api/auto-sync/settings', { enabled: false, intervalMinutes: 10 })).status, 503);
  const closed = once(app.server, 'close'); finish(); await writing;
  assert.equal((await shutdown).status, 200); await closed;
  const stored = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')); assert.equal(stored.drafts.final.text, 'saved before shutdown');
});
test('HTTP boundaries require same-origin CSRF, protect keys, and publish only the edited preview', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')); let published = [];
  const review = { id: '1234567890', productId: '555', product: '테스트', content: '맛있어요', rating: 5, store: '테스트', hasReply: false };
  const connector = { status: async () => ({ connected: true }), sync: async () => ({ reviews: [review], total: 1 }), publish: async (r, text, beforeClick) => { await beforeClick(); published.push(text); return { reply: text }; } };
  const tones = [];
  const ai = { configured: false, configure(key) { this.key = key; this.configured = true; }, generate: async (review, settings) => { tones.push(settings.tone); return 'AI 추천 초안입니다.'; } };
  const port = 14317; const { server, store, csrf } = await createApp({ directory, ablyConnector: { status: async () => ({ connected: false }), sync: async () => ({ reviews: [], total: 0 }) }, connector, coupangConnector: { status: async () => ({ connected: false }) }, ai, port, maintenanceInterval: 0 }); server.listen(port, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanupTestDirectory(directory); });
  const base = `http://127.0.0.1:${port}`;
  const post = (route, data, origin = base, token = csrf) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Review-Token': token }, body: JSON.stringify(data) });
  assert.equal((await post('/api/sync', {}, 'https://foreign.example')).status, 403); assert.equal((await post('/api/sync', {}, base, 'bad')).status, 403);
  assert.equal((await post('/api/sync', {})).status, 200);
  await post('/api/settings', { apiKey: 'sk-test-secret-only', brand: '테스트', model: 'gpt-5-mini' });
  const session = await fetch(base + '/api/session').then(r => r.json()); assert.equal(session.aiConfigured, true); assert.equal(JSON.stringify(session).includes('sk-test-secret-only'), false); assert.equal(JSON.stringify(store.data).includes('sk-test-secret-only'), false);
  await post(`/api/reviews/${review.id}/suggest`, {}); await post(`/api/reviews/${review.id}/draft`, { text: '내가 수정한 최종 답글입니다.' }); assert.equal(published.length, 0);
  const defaultTone = store.data.settings.tone;
  const customTone = '  이모지 없이 짧고 다정하게  ';
  const custom = await post(`/api/reviews/${review.id}/suggest`, { tone: customTone }).then(r => r.json());
  assert.equal(custom.tone, customTone.trim()); assert.equal(tones.at(-1), customTone.trim()); assert.equal(store.data.settings.tone, defaultTone);
  for (const tone of ['', '   ', null, {}, '가'.repeat(201)]) assert.equal((await post(`/api/reviews/${review.id}/suggest`, { tone })).status, 400);
  assert.equal(tones.length, 2);
  await post(`/api/reviews/${review.id}/suggest`, {}); assert.equal(tones.at(-1), defaultTone); assert.equal(published.length, 0);
  assert.equal(store.data.drafts[review.id].text, '내가 수정한 최종 답글입니다.');
  assert.equal((await post(`/api/reviews/${review.id}/publish`, {})).status, 409);
  const prepared = await post(`/api/reviews/${review.id}/prepare`, { text: '내가 수정한 최종 답글입니다.', fingerprint: fingerprint(review) }).then(r => r.json()); assert.equal(published.length, 0);
  assert.equal((await post(`/api/reviews/${review.id}/publish`, { token: prepared.token })).status, 200); assert.deepEqual(published, ['내가 수정한 최종 답글입니다.']);
  const before = store.data.settings.brand; assert.equal((await post('/api/settings', { brand: '다른 이름', model: 'bad model!' })).status, 400); assert.equal(store.data.settings.brand, before);
});

test('auto-login settings require CSRF and never expose credentials or publish reviews', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-'));
  const connector = { status: async () => ({ connected: true }), login: () => assert.fail('An active session must not log in again'), publish: () => assert.fail('Settings must not publish') };
  const port = 14318, base = `http://127.0.0.1:${port}`;
  const { server, csrf, autoLogin, store } = await createApp({ directory, ablyConnector: { status: async () => ({ connected: false }), sync: async () => ({ reviews: [], total: 0 }) }, connector, coupangConnector: { status: async () => ({ connected: false }) }, port, maintenanceInterval: 0 }); server.listen(port, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanupTestDirectory(directory); });
  const post = (route, data, token = csrf) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Review-Token': token }, body: JSON.stringify(data) });
  const input = { enabled: true, method: 'commerce', username: 'synthetic-http-user', password: 'synthetic-http-password' };
  assert.equal((await post('/api/auth/settings', input, 'wrong')).status, 403);
  assert.equal((await post('/api/auth/settings', { enabled: true })).status, 400);
  const saved = await post('/api/auth/settings', input); assert.equal(saved.status, 200); assert.equal((await saved.json()).configured, true);
  await autoLogin.pending;
  for (const route of ['/api/status', '/api/session', '/api/reviews']) {
    const text = await fetch(base + route).then(r => r.text());
    assert.equal(text.includes(input.username), false); assert.equal(text.includes(input.password), false);
  }
  assert.equal(JSON.stringify(store.data).includes(input.password), false);
  assert.equal((await fetch(base + '/.local/naver-auth.json')).status, 404);
  assert.equal((await post('/api/auth/forget', {}, 'wrong')).status, 403);
  const forgotten = await post('/api/auth/forget', {}).then(r => r.json()); assert.equal(forgotten.configured, false); assert.equal(forgotten.enabled, false);
});
