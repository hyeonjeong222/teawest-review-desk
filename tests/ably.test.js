import { emptyDeliveryConnectors } from './delivery-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { cleanupTestDirectory } from './cleanup.js';
import { AblyConnector, normalizeAblyReview } from '../src/ably.js';
import { createApp } from '../src/server.js';
import { AppError } from '../src/core.js';

const raw = { sno: 123, goods: { sno: 456, name: '테스트 상품' }, contents: '후기입니다.', images: [], satisfaction: false, status: 1, created_at: '2026-11-15T00:00:00', order_item_sno: 987, height: 'private' };
const ably = normalizeAblyReview(raw, '테스트');
const forbidden = () => assert.fail('Ably must never call Naver details, publishing, or AI');
test('Ably preserves true satisfaction and Korean dates without inventing stars or exposing order/body data', () => {
  const image = 'https://d3ha2047wt6x28.cloudfront.net/photo.jpg';
  const review = normalizeAblyReview({ ...raw, images: [image, image, 'javascript:alert(1)', 'https://evil.example/photo', 'https://d3ha2047wt6x28.cloudfront.net.evil.example/photo'] }, '테스트');
  assert.equal(review.rating, null); assert.equal(review.satisfaction, false); assert.equal(review.id, 'ably-123'); assert.equal(review.author, '구매자');
  assert.equal(review.dateTimestamp, Date.parse('2026-11-14T15:00:00Z')); assert.equal(review.readOnly, true);
  assert.deepEqual(review.media, [image]); assert.equal(review.order_item_sno, undefined); assert.equal(review.height, undefined);
  const hidden = normalizeAblyReview({ ...raw, status: 2, images: [image] }, '테스트'); assert.deepEqual(hidden.media, []); assert.ok(!hidden.content.includes(raw.contents));
  for (const change of [{ satisfaction: 'false' }, { sno: '123' }, { created_at: 'invalid' }]) assert.throws(() => normalizeAblyReview({ ...raw, ...change }, '테스트'), e => e.code === 'ABLY_LAYOUT');
});

function paged(mode) {
  const connector = new AblyConnector('unused'), calls = [];
  connector.workspace = async () => ({ page: {}, store: '테스트' });
  connector.storeName = async () => mode === 'account' ? '다른 마켓' : '테스트';
  connector.fetchPage = async (session, page) => {
    calls.push(page);
    const rows = page === 1 ? Array.from({ length: 30 }, (_, i) => ({ ...raw, sno: i + 1, created_at: i < 28 ? '2025-01-01T12:00:00' : i === 28 ? '2026-05-16T00:00:00' : '2026-05-15T23:59:59' })) : [{ ...raw, sno: mode === 'duplicate' ? 1 : 31 }];
    return { reviews: mode === 'incomplete' && page === 2 ? [] : rows, total_count: mode === 'changed' && page === 2 ? 32 : 31 };
  };
  return { connector, calls };
}
test('Ably reads every modification-ordered page, filters inclusive creation dates, rejects partial data', async () => {
  const { connector, calls } = paged(), result = await connector.sync('6m', new Date('2026-11-15T00:00:00Z'));
  assert.deepEqual(calls, [1, 2]); assert.equal(result.sourceTotal, 31); assert.equal(result.total, 2);
  assert.deepEqual(result.reviews.map(r => r.id), ['ably-29', 'ably-31']);
  for (const [mode, code] of [['duplicate', 'ABLY_CHANGED'], ['changed', 'ABLY_CHANGED'], ['incomplete', 'INCOMPLETE_SYNC'], ['account', 'STORE_CHANGED']]) await assert.rejects(paged(mode).connector.sync('6m'), e => e.code === code);
});
test('Ably uses only the known GET origin, blocks redirects, and discards expired credentials', async () => {
  const connector = new AblyConnector('unused'); let requested, options, status = 200, disposed = 0;
  const session = { authorization: 'test-token', page: { context: () => ({ request: { get: async (url, args) => { requested = url; options = args; return { status: () => status, json: async () => ({ reviews: [], total_count: 0 }), dispose: async () => disposed++ }; } } }) } };
  connector.session = session; connector.probe = { at: Date.now() };
  await connector.fetchPage(session, 2);
  assert.equal(requested, 'https://api.a-bly.com/seller/reviews/?page=2&per_page=30&order_by=LATEST'); assert.equal(options.maxRedirects, 0); assert.equal(options.headers.authorization, session.authorization);
  status = 401; await assert.rejects(connector.fetchPage(session, 1), e => e.code === 'ABLY_LOGIN_REQUIRED'); assert.equal(connector.session, null); assert.equal(connector.probe, null); assert.equal(disposed, 2); assert.equal(connector.publish, undefined);
});

test('HTTP Ably sync preserves Naver/Coupang and drafts; read-only endpoints and failed-sync cache survive restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-'));
  const naver = { id: '123', content: '네이버 후기', product: '상품', rating: 5, author: 'n***', date: '2026.11.15', hasReply: false };
  const coupang = { ...naver, id: 'coupang-123', platform: 'coupang', readOnly: true };
  let fail = false, opened = 0;
  const connector = { status: async () => ({ connected: true }), sync: async () => ({ reviews: [naver], total: 1 }), detail: forbidden, publish: forbidden };
  const coupangConnector = { status: async () => ({ connected: true }), sync: async () => ({ reviews: [coupang], total: 1 }) };
  const ablyConnector = { status: async () => ({ connected: !fail }), open: async () => { opened++; return { connected: true }; }, sync: async () => { if (fail) throw new AppError('로그인 필요', 409, 'ABLY_LOGIN_REQUIRED'); return { reviews: [ably], total: 1 }; } };
  const port = 14322, base = `http://127.0.0.1:${port}`;
  const { server, store, csrf, ablyService } = await createApp({ deliveryConnectors: emptyDeliveryConnectors(), directory, connector, coupangConnector, ablyConnector, ai: { configured: false, generate: forbidden }, port, maintenanceInterval: 0 });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanupTestDirectory(directory); });
  const post = (route, data = {}) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'X-Review-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  await store.update(s => { s.reviews = [naver, coupang]; s.drafts['123'] = { text: '작성 중인 네이버 초안' }; });
  assert.equal((await post('/api/sync', { platform: 'ably', period: '6m' }).then(r => r.json())).reviews.length, 3);
  assert.deepEqual(store.review('123'), naver); assert.deepEqual(store.review('coupang-123'), coupang); assert.equal(store.data.drafts['123'].text, '작성 중인 네이버 초안');
  const mixed = await post('/api/sync', { platform: 'all' }).then(r => r.json()); assert.equal(mixed.reviews.length, 3); assert.deepEqual(mixed.warnings, []);
  const status = await fetch(base + '/api/status').then(r => r.json()); assert.equal(status.platforms.ably.connected, true);
  await post('/api/browser/open', { platform: 'ably' }); assert.equal(opened, 1);
  assert.equal((await post('/api/reviews/ably-123/detail').then(r => r.json())).id, ably.id);
  for (const action of ['draft', 'suggest', 'prepare', 'publish']) { const response = await post(`/api/reviews/ably-123/${action}`, { text: '등록하지 않을 답글', token: 'fake' }); assert.equal(response.status, 403); assert.equal((await response.json()).code, 'READ_ONLY_REVIEW'); }
  fail = true; const before = JSON.stringify(store.data);
  assert.equal((await post('/api/sync', { platform: 'ably' })).status, 409); assert.equal(JSON.stringify(store.data), before);
  const partial = await post('/api/sync', { platform: 'all' }).then(r => r.json()); assert.equal(partial.reviews.length, 3); assert.equal(partial.warnings[0].platform, 'ably');
  const stable = JSON.stringify(store.data); ablyConnector.sync = async () => ({ reviews: [ably, ably], total: 2 }); await assert.rejects(ablyService.sync('6m'), e => e.code === 'INCOMPLETE_SYNC'); assert.equal(JSON.stringify(store.data), stable);
  const restored = new store.constructor(directory); await restored.init(); assert.equal(restored.review(ably.id).satisfaction, false); assert.equal(restored.data.drafts['123'].text, '작성 중인 네이버 초안');
});
