import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { NaverInquiryService, parseInquiryCounts } from '../src/naver-inquiries.js';
import { SerialQueue } from '../src/core.js';
import { createApp } from '../src/server.js';
import { cleanupTestDirectory } from './cleanup.js';

const counts = { talktalkInquiryCount: '0', customerInquiryCount: '12', productInquiryCount: '1,234', csTicketCount: 3 };
function fixture() {
  const calls = [], response = { status: () => 200, json: async () => ({ ...counts, talkAccountId: 'private-chat-id', customerInquiries: [{ text: 'private-content' }] }), dispose: async () => calls.push('dispose') };
  const page = { request: { get: async (url, options) => { calls.push({ url, options }); return response; } } };
  const connector = { status: async () => ({ connected: true, store: '테스트' }), getPage: async () => page };
  return { calls, response, page, connector, service: new NaverInquiryService(connector, new SerialQueue()) };
}
test('counts distinguish a verified zero from missing, negative, malformed and unsafe values', () => {
  assert.deepEqual(parseInquiryCounts(counts).map(item => item.count), [0, 12, 1234, 3]);
  for (const value of [null, undefined, '', '—', true, -1, '1.5', '1,2', '9007199254740992']) {
    assert.throws(() => parseInquiryCounts({ ...counts, talktalkInquiryCount: value }), e => e.code === 'INQUIRY_LAYOUT');
  }
});
test('summary uses only the observed GET, shares the review queue, coalesces refreshes and strips customer data', async () => {
  const { service, calls } = fixture();
  assert.ok(service.publicState().items.every(item => item.count === null));
  let release; const hold = new Promise(resolve => { release = resolve; });
  const blockingReview = service.queue.run(() => hold);
  const first = service.sync(), second = service.sync(); assert.equal(first, second);
  assert.equal(calls.length, 0); release(); await blockingReview;
  const result = await first;
  assert.equal(result.store, '테스트'); assert.equal(result.items[2].count, 1234);
  assert.equal(calls[0].url, 'https://sell.smartstore.naver.com/api/v1/sellers/dashboards/inquiries');
  assert.equal(calls[0].options.maxRedirects, 0); assert.equal(calls.at(-1), 'dispose');
  assert.equal(calls.filter(x => typeof x === 'object').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-chat-id|private-content|customerInquiries/);
});
test('login loss and malformed responses never become zero; a changed store invalidates the snapshot', async () => {
  const { service, connector, response } = fixture(); const prior = await service.sync();
  response.status = () => 401;
  await assert.rejects(service.sync(), e => e.code === 'LOGIN_REQUIRED'); assert.equal(service.publicState(), prior);
  response.status = () => 200; response.json = async () => ({ ...counts, productInquiryCount: null });
  await assert.rejects(service.sync(), e => e.code === 'INQUIRY_LAYOUT'); assert.equal(service.publicState(), prior);
  response.json = async () => counts;
  let step = 0; connector.status = async () => ({ connected: true, store: step++ ? '다른 매장' : '테스트' });
  await assert.rejects(service.sync(), e => e.code === 'STORE_CHANGED'); assert.equal(service.publicState().store, null);
});
test('category links use a separate matching tab and cannot navigate the review editor or arbitrary URLs', async () => {
  const { service, connector } = fixture(); let target, created = 0, focuses = 0;
  const review = { url: () => 'https://sell.smartstore.naver.com/#/review/search', goto: () => assert.fail('Must preserve the review page') };
  const inquiry = { url: () => target, goto: async url => { target = url; }, bringToFront: async () => focuses++ };
  const pages = [review]; const context = { pages: () => pages, newPage: async () => { created++; pages.push(inquiry); return inquiry; } };
  connector.connect = async () => ({ contexts: () => [context] });
  await assert.rejects(service.open('https://external.example'), e => e.code === 'INVALID_INQUIRY_CATEGORY');
  assert.equal(created, 0);
  assert.equal((await service.open('product')).opened, true);
  assert.equal(target, 'https://sell.smartstore.naver.com/#/comment/');
  await service.open('product'); assert.equal(created, 1); assert.equal(focuses, 2);
  connector.status = async () => ({ connected: false }); let loginOpened = false;
  connector.open = async () => { loginOpened = true; };
  assert.equal((await service.open('customer')).loginRequired, true); assert.equal(loginOpened, true); assert.equal(created, 1);
});
test('inquiry HTTP routes enforce CSRF and do not alter review data', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-'));
  const { connector } = fixture(), port = 14329, base = `http://127.0.0.1:${port}`;
  const app = await createApp({ directory, connector, port, maintenanceInterval: 0 });
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await cleanupTestDirectory(directory); });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  app.store.data.drafts.kept = { text: '작성 중인 리뷰 답글' };
  const before = JSON.stringify(app.store.data);
  const post = (route, data, token = app.csrf) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Review-Token': token }, body: JSON.stringify(data) });
  for (const route of ['/api/inquiries/naver/sync', '/api/inquiries/naver/open']) assert.equal((await post(route, {}, 'bad')).status, 403);
  const result = await post('/api/inquiries/naver/sync', {}); assert.equal(result.status, 200); assert.equal((await result.json()).items.length, 4);
  assert.equal((await post('/api/inquiries/naver/open', { category: 'unsupported' })).status, 400);
  assert.equal(JSON.stringify(app.store.data), before);
});
