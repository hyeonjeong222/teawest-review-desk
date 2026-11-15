import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { cleanupTestDirectory } from './cleanup.js';
import { CoupangConnector, coupangDateRange, coupangDateWindows, normalizeCoupangReview } from '../src/coupang.js';
import { CoupangReviewService } from '../src/coupang-service.js';
import { Store, ReviewService, AppError, fingerprint } from '../src/core.js';
import { createApp } from '../src/server.js';

const raw = { reviewId: 123, productId: 456, reviewAt: Date.parse('2026-11-12T13:00:00+09:00'), rating: 1, memberName: '테스트고객', itemName: '테스트 상품', reviewTitle: '제목', reviewContent: '리뷰 본문', vendorId: 'test-vendor', attachment: '{"imageAttachments":[]}' };
const naver = { id: '123', productId: '456', product: '네이버 상품', content: '네이버 후기', rating: 5, author: 'n***', date: '2026.11.15', store: '테스트', hasReply: false };
const coupang = normalizeCoupangReview(raw, '테스트');
const forbidden = () => assert.fail('Read-only Coupang must never call Naver or AI');

test('Coupang ranges use Korean dates and cover leap/year boundaries without gaps or overlaps', () => {
  assert.deepEqual(coupangDateRange('1m', new Date('2026-03-30T15:00:00Z')), { from: '2026-03-01', to: '2026-03-31' });
  assert.deepEqual(coupangDateRange('1m', new Date('2024-03-31T00:00:00Z')), { from: '2024-03-01', to: '2024-03-31' });
  assert.deepEqual(coupangDateRange('3m', new Date('2026-01-15T00:00:00Z')), { from: '2025-10-16', to: '2026-01-15' });
  for (const period of ['1m', '3m', '6m', '1y']) {
    const range = coupangDateRange(period, new Date('2024-03-31T00:00:00Z')), windows = coupangDateWindows(range.from, range.to), dates = [];
    for (const window of windows) {
      const duration = (Date.parse(window.to) - Date.parse(window.from)) / 86400000 + 1; assert.ok(duration >= 1 && duration <= 28);
      for (let day = Date.parse(window.from); day <= Date.parse(window.to); day += 86400000) dates.push(day);
    }
    dates.sort((a, b) => a - b); assert.equal(dates[0], Date.parse(range.from)); assert.equal(dates.at(-1), Date.parse(range.to));
    assert.equal(new Set(dates).size, dates.length); assert.equal(dates.length, (Date.parse(range.to) - Date.parse(range.from)) / 86400000 + 1);
  }
  assert.throws(() => coupangDateRange('bad'));
});

test('Coupang normalizes IDs separately, masks authors and only includes trusted public image URLs', () => {
  const review = normalizeCoupangReview({ ...raw, attachment: JSON.stringify({ imageAttachments: ['https://image1.coupangcdn.com/review.jpg', { url: 'https://image1.coupangcdn.com/review.jpg' }, 'javascript:alert(1)', 'https://coupangcdn.com.evil.example/photo'] }) }, '테스트');
  assert.equal(review.id, 'coupang-123'); assert.equal(review.readOnly, true); assert.equal(review.hasReply, false);
  assert.equal(review.author, '테***'); assert.equal(JSON.stringify(review).includes(raw.memberName), false); assert.equal(review.vendorId, undefined);
  assert.equal(review.content, '제목\n\n리뷰 본문'); assert.deepEqual(review.media, ['https://image1.coupangcdn.com/review.jpg']);
  assert.equal(normalizeCoupangReview({ ...raw, reviewTitle: '같은 글', reviewContent: '같은 글' }, '테스트').content, '같은 글');
  const hidden = normalizeCoupangReview({ ...raw, blinded: true }, '테스트'); assert.ok(!hidden.content.includes(raw.reviewContent)); assert.deepEqual(hidden.media, []);
  for (const attachment of ['null', 'invalid JSON', '{"imageAttachments":{}}']) assert.deepEqual(normalizeCoupangReview({ ...raw, attachment }, '테스트').media, []);
  assert.throws(() => normalizeCoupangReview({ ...raw, rating: 6 }, '테스트'), e => e.code === 'COUPANG_LAYOUT');
});

function pagedConnector(mode = 'valid') {
  const connector = new CoupangConnector('unused'); connector.workspace = async () => ({ page: {}, store: '테스트' });
  const calls = []; let firstWindow;
  connector.fetchPage = async (page, window, index) => {
    calls.push({ window, index }); firstWindow ??= window.to;
    if (window.to !== firstWindow) return { content: [], pagination: { currentPage: index, totalElements: 0, totalPages: 0 } };
    return { content: [{ ...raw, reviewId: index === 0 || mode === 'duplicate' ? 123 : 124, vendorId: mode === 'account' && index === 1 ? 'different-vendor' : raw.vendorId }], pagination: { currentPage: index, totalElements: mode === 'changed' && index === 1 ? 3 : 2, totalPages: mode === 'incomplete' ? 1 : 2 } };
  };
  return { connector, calls };
}
test('Coupang collects every page/window and rejects incomplete, duplicate, changed or cross-account data', async () => {
  const { connector, calls } = pagedConnector(); const result = await connector.sync('3m');
  assert.equal(result.total, 2); assert.equal(result.reviews.length, 2); assert.equal(calls[1].index, 1); assert.ok(calls.length >= 4);
  for (const [mode, code] of [['incomplete', 'INCOMPLETE_SYNC'], ['duplicate', 'INCOMPLETE_SYNC'], ['changed', 'COUPANG_CHANGED'], ['account', 'STORE_CHANGED']]) await assert.rejects(pagedConnector(mode).connector.sync('3m'), e => e.code === code);
});

test('Coupang requests only the observed read endpoint and reports an expired session', async () => {
  const connector = new CoupangConnector('unused'); let args;
  const page = { evaluate: async (fn, params) => { args = params; return { status: 200, data: { success: true, data: { content: [], pagination: {} } } }; } };
  await connector.fetchPage(page, { from: '2026-11-01', to: '2026-11-15' }, 2);
  assert.equal(args.endpoint, '/tenants/cs/product/review/search'); assert.equal(args.body.salesStatus, ''); assert.equal(args.body.pageIndex, 2); assert.equal(args.body.pageSize, 50);
  page.evaluate = async () => ({ status: 401 }); await assert.rejects(connector.fetchPage(page, {}, 0), e => e.code === 'COUPANG_LOGIN_REQUIRED');
  assert.equal(connector.publish, undefined);
});

test('each platform sync preserves the other platform, Naver drafts, reply state and failed-sync cache', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-desk-test-')); t.after(() => cleanupTestDirectory(directory));
  const store = new Store(directory); await store.init();
  await store.update(s => { s.reviews = [{ ...naver }, { ...naver, id: '125', hasReply: true, reply: '저장된 답글' }]; s.drafts['123'] = { text: '작성 중인 초안입니다.' }; });
  const connector = { sync: async () => ({ reviews: [coupang], total: 1, period: '3m' }) }, service = new CoupangReviewService(store, connector);
  await service.sync('3m'); assert.equal(store.data.reviews.length, 3); assert.equal(store.review('123').platform, undefined); assert.equal(store.review('coupang-123').readOnly, true);
  const naverService = new ReviewService(store, { sync: async () => ({ reviews: [{ ...naver }, { ...naver, id: '125', hasReply: true }], total: 2, period: '1m' }), detail: forbidden, publish: forbidden }, { generate: forbidden });
  await Promise.all([naverService.sync('1m'), service.sync('3m')]);
  assert.equal(store.data.reviews.length, 3); assert.equal(store.review('125').reply, '저장된 답글'); assert.equal(store.data.drafts['123'].text, '작성 중인 초안입니다.');
  assert.equal(store.data.syncs.naver.period, '1m'); assert.equal(store.data.syncs.coupang.period, '3m'); assert.equal(store.data.reviews[0].id, '125');
  assert.equal((await naverService.detail(coupang.id)).id, coupang.id);
  await assert.rejects(naverService.suggest(coupang.id), e => e.code === 'READ_ONLY_REVIEW');
  assert.throws(() => naverService.prepare(coupang.id, '작성할 수 없는 답글', fingerprint(coupang), 'forged'), e => e.code === 'READ_ONLY_REVIEW');
  naverService.intents.set('forged', { id: coupang.id, expires: Date.now() + 10000, fingerprint: fingerprint(coupang) });
  await assert.rejects(naverService.publish(coupang.id, 'forged'), e => e.code === 'READ_ONLY_REVIEW');
  const before = JSON.stringify(store.data);
  connector.sync = async () => ({ reviews: [coupang, coupang], total: 2 }); await assert.rejects(service.sync('3m'), e => e.code === 'INCOMPLETE_SYNC'); assert.equal(JSON.stringify(store.data), before);
  connector.sync = async () => { throw new AppError('로그인 필요', 409, 'COUPANG_LOGIN_REQUIRED'); }; await assert.rejects(service.sync('3m')); assert.equal(JSON.stringify(store.data), before);
  const restored = new Store(directory); await restored.init(); assert.equal(restored.data.reviews.length, 3); assert.equal(restored.review('coupang-123').readOnly, true);
});

test('HTTP mixed sync reports partial failure, preserves cached reviews, and rejects all Coupang reply routes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')); let fail = false;
  const connector = { status: async () => ({ connected: true }), sync: async () => ({ reviews: [naver], total: 1 }), detail: forbidden, publish: forbidden };
  const coupangConnector = { status: async () => ({ connected: !fail }), sync: async () => { if (fail) throw new AppError('로그인 필요', 409, 'COUPANG_LOGIN_REQUIRED'); return { reviews: [coupang], total: 1 }; } };
  const port = 14320, base = `http://127.0.0.1:${port}`;
  const { server, store, csrf } = await createApp({ directory, ablyConnector: { status: async () => ({ connected: false }), sync: async () => ({ reviews: [], total: 0 }) }, connector, coupangConnector, ai: { configured: false, generate: forbidden }, port, maintenanceInterval: 0 });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanupTestDirectory(directory); });
  const post = (route, data = {}) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'X-Review-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const sync = await post('/api/sync', { platform: 'all' }).then(r => r.json()); assert.equal(sync.reviews.length, 2); assert.deepEqual(sync.warnings, []);
  const status = await fetch(base + '/api/status').then(r => r.json()); assert.equal(status.platforms.coupang.connected, true); assert.equal(status.connected, true);
  for (const action of ['draft', 'suggest', 'prepare', 'publish']) { const response = await post(`/api/reviews/${coupang.id}/${action}`, { text: '등록하지 않을 답글', token: 'fake' }); assert.equal(response.status, 403); assert.equal((await response.json()).code, 'READ_ONLY_REVIEW'); }
  assert.equal((await post(`/api/reviews/${coupang.id}/detail`).then(r => r.json())).id, coupang.id); assert.deepEqual(store.data.drafts, {});
  fail = true; const partial = await post('/api/sync', { platform: 'all' }).then(r => r.json()); assert.equal(partial.reviews.length, 2); assert.equal(partial.warnings[0].platform, 'coupang');
  assert.equal((await post('/api/sync', { platform: 'coupang' })).status, 409); assert.equal(store.data.reviews.length, 2);
  assert.equal((await post('/api/sync', { platform: 'unknown' })).status, 400);
});
