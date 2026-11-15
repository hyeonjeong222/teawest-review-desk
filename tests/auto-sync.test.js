import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Store, ReviewService, AppError } from '../src/core.js';
import { CoupangReviewService } from '../src/coupang-service.js';
import { AblyReviewService } from '../src/ably-service.js';
import { AutoReviewSync } from '../src/auto-sync.js';
import { createApp } from '../src/server.js';
import { cleanupTestDirectory } from './cleanup.js';
const platforms = ['naver', 'coupang', 'ably'];
const forbidden = () => assert.fail('Background refresh must never generate or publish a reply');
const row = (platform, id) => ({ id: platform === 'naver' ? String(id) : `${platform}-${id}`, platform, content: '후기', product: '상품', author: '구매자', rating: platform === 'ably' ? null : 5, satisfaction: true, date: '2026.11.15', store: platform, hasReply: false });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')); t.after(() => cleanupTestDirectory(directory));
  const store = new Store(directory); await store.init();
  const now = { value: Date.parse('2026-11-15T00:00:00Z') }, controls = {}, sources = {};
  for (const [index, platform] of platforms.entries()) {
    controls[platform] = { count: 1, connected: true, calls: [], store: platform, error: null };
    const control = controls[platform];
    const connector = { status: async () => ({ connected: control.connected, store: control.store }), sync: async period => { control.calls.push(period); if (control.error) throw control.error; return { reviews: Array.from({ length: control.count }, (_, i) => row(platform, i + 1)), total: control.count, period, store: control.store }; }, publish: forbidden };
    const service = platform === 'naver' ? new ReviewService(store, connector, { generate: forbidden }) : platform === 'coupang' ? new CoupangReviewService(store, connector) : new AblyReviewService(store, connector);
    sources[platform] = { connector, service, autoLogin: { schedule: async () => {} } };
    store.data.syncs[platform] = { period: ['1m', '3m', '6m'][index], store: platform };
  }
  const auto = new AutoReviewSync(store, sources, { now: () => now.value });
  return { store, directory, now, controls, sources, auto };
}

test('automatic refresh collects every platform on startup and on schedule, deduplicates jobs, and preserves drafts', async t => {
  const { store, now, controls, sources, auto } = await fixture(t);
  store.data.reviews = [row('naver', 1)]; store.data.drafts['1'] = { text: '내가 쓰는 초안' };
  const gate = deferred(); sources.ably.autoLogin.schedule = () => gate.promise;
  const first = auto.tick(); auto.tick(); auto.tick();
  assert.equal(auto.pending.size, 3); gate.resolve(); await first;
  assert.equal(store.data.reviews.length, 3); assert.equal(store.data.drafts['1'].text, '내가 쓰는 초안');
  for (const [i, platform] of platforms.entries()) assert.deepEqual(controls[platform].calls, [['1m', '3m', '6m'][i]]);
  await auto.tick(); assert.equal(controls.naver.calls.length, 1);
  now.value += 600000; for (const platform of platforms) controls[platform].count = 2;
  await auto.tick(); assert.equal(store.data.reviews.length, 6); assert.equal(new Set(store.data.reviews.map(r => r.id)).size, 6);
  for (const platform of platforms) assert.equal(auto.publicState().platforms[platform].added, 1);
  assert.equal(store.data.drafts['1'].text, '내가 쓰는 초안'); assert.deepEqual(store.data.submissions, {});
});

test('a disconnected or failing platform keeps its cache, others proceed, and reconnection resumes collection', async t => {
  const { store, now, controls, auto } = await fixture(t); await auto.tick();
  const cached = JSON.stringify(store.review('coupang-1')); controls.coupang.connected = false;
  controls.naver.count = 2; now.value += 600000; await auto.tick();
  assert.equal(store.data.reviews.filter(r => r.platform === 'naver').length, 2); assert.equal(JSON.stringify(store.review('coupang-1')), cached);
  assert.equal(auto.publicState().platforms.coupang.phase, 'login_required');
  controls.coupang.connected = true; controls.coupang.count = 2; now.value += 60000; await auto.tick();
  assert.equal(store.data.reviews.filter(r => r.platform === 'coupang').length, 2); assert.equal(controls.naver.calls.length, 2);
  controls.ably.error = new AppError('형식 변경', 502, 'ABLY_LAYOUT'); now.value += 600000; await auto.tick();
  assert.equal(auto.publicState().platforms.ably.phase, 'error'); assert.equal(store.review('ably-1').platform, 'ably');
  const failedAt = now.value; now.value += 600000; await auto.tick();
  assert.equal(Date.parse(auto.publicState().platforms.ably.nextRunAt), failedAt + 1800000);
});

test('queued automatic work uses the latest manual period and never overlaps an active review operation', async t => {
  const { sources, controls, auto } = await fixture(t), gate = deferred();
  const active = sources.naver.service.queue.run(() => gate.promise);
  const manual = sources.naver.service.sync('1y'); const background = auto.tick();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(controls.naver.calls.length, 0);
  gate.resolve(); await Promise.all([active, manual, background]);
  assert.deepEqual(controls.naver.calls, ['1y', '1y']);
});

test('disabling cancels queued automatic reads, settings survive restart, and changed seller accounts are not overwritten', async t => {
  const { store, directory, sources, controls, auto } = await fixture(t), gate = deferred();
  const active = sources.naver.service.queue.run(() => gate.promise), pending = auto.tick();
  await new Promise(resolve => setImmediate(resolve)); await auto.save({ enabled: false, intervalMinutes: 30 }); gate.resolve(); await Promise.all([active, pending]);
  assert.equal(controls.naver.calls.length, 0); const restored = new Store(directory); await restored.init(); assert.deepEqual(restored.data.autoSync, { enabled: false, intervalMinutes: 30 });
  await assert.rejects(auto.save({ enabled: true, intervalMinutes: 1 }));
  await assert.rejects(auto.save(null), error => error.status === 400);
  controls.naver.store = '다른 판매자'; await auto.save({ enabled: true, intervalMinutes: 10 }); await auto.tick();
  assert.equal(controls.naver.calls.length, 0); assert.equal(auto.publicState().platforms.naver.phase, 'error'); assert.equal(store.data.syncs.naver.store, 'naver');
  auto.stop(); assert.deepEqual(await auto.tick(), []);
});

test('HTTP settings are CSRF protected and the server schedules collection without an open webpage', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')), port = 14325, base = `http://127.0.0.1:${port}`;
  const connectors = Object.fromEntries(platforms.map(platform => [platform, { status: async () => ({ connected: true, store: platform }), sync: async period => ({ reviews: [row(platform, 1)], total: 1, period, store: platform }), publish: forbidden }]));
  const { server, store, csrf, autoSync } = await createApp({ directory, connector: connectors.naver, coupangConnector: connectors.coupang, ablyConnector: connectors.ably, ai: { configured: false, generate: forbidden }, port, maintenanceInterval: 20000 });
  server.listen(port, '127.0.0.1'); await once(server, 'listening'); await Promise.allSettled([...autoSync.pending.values()]);
  t.after(async () => { autoSync.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...autoSync.pending.values()]); await cleanupTestDirectory(directory); });
  assert.equal(store.data.reviews.length, 3); assert.deepEqual(store.data.submissions, {});
  const post = (data, token = csrf) => fetch(base + '/api/auto-sync/settings', { method: 'POST', headers: { Origin: base, 'X-Review-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await post({ enabled: false, intervalMinutes: 10 }, 'bad')).status, 403); assert.equal((await post({ enabled: true, intervalMinutes: '10' })).status, 400);
  const result = await post({ enabled: false, intervalMinutes: 30 }).then(r => r.json()); assert.equal(result.enabled, false);
  const cache = await fetch(base + '/api/reviews').then(r => r.json()); assert.equal(cache.autoSync.intervalMinutes, 30); assert.equal(cache.reviews.length, 3);
  const restarted = new Store(directory); await restarted.init(); assert.equal(restarted.data.autoSync.enabled, false);
});
