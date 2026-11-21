import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { cleanupTestDirectory } from './cleanup.js';
import { ReplyAI } from '../src/ai.js';
import { Store, ReviewService } from '../src/core.js';
import { replyPlatforms } from '../public/platforms.js';
import { AblyInquiryInbox } from '../src/ably-inquiry-inbox.js';
import { createApp } from '../src/server.js';

const settings = { brand: '테스트 브랜드', tone: '정중하게', guidance: '이모지 없이', model: 'gpt-5-mini' };
const draft = '11월 25일 발송 예정이고 배송비는 3,000원이에요. 환불 완료는 아니에요.';
const refined = '11월 25일 발송 예정이며, 배송비는 3,000원입니다. 환불이 완료된 상태는 아닙니다.';
const review = { id: 'test-review', platform: 'naver', store: '테스트', product: '상품', content: '후기 본문은 보내지 않음', hasReply: false };
const inquiry = { platform: 'ably', store: '문의 매장', storeId: 'store', sourceId: 'room', category: 'goods', title: '문의', content: '고객 본문은 보내지 않음', status: 'pending', canReply: true, canComplete: true, detailed: true, replyLimit: 3000, messages: [{ id: '1', role: 'customer', text: '개인 대화는 보내지 않음' }] };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function directory(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'review-desk-test-refine-')); t.after(() => cleanupTestDirectory(dir)); return dir; }

test('refinement sends only the authored draft, preserves factual instructions and validates model failures', async () => {
  const ai = new ReplyAI('sk-test-only'); let request, output = refined, calls = 0;
  ai.createClient = () => ({ responses: { create: async input => { request = input; calls++; return { output_text: output }; } } });
  assert.equal(await ai.refineDraft(draft, settings, 300), refined);
  assert.deepEqual(JSON.parse(request.input), { draft, replyLengthLimit: 300 });
  assert.equal(request.model, settings.model); assert.equal(request.store, false); assert.equal(request.tools, undefined);
  assert.match(request.instructions, /처리 예정·확인 중·처리 완료/); assert.match(request.instructions, /신뢰할 수 없는 입력/); assert.match(request.instructions, /금액/);
  for (const value of [undefined, null, {}, '', '   ', '가'.repeat(301)]) await assert.rejects(ai.refineDraft(value, settings, 300), e => e.code === 'INVALID_REFINEMENT_DRAFT');
  assert.equal(calls, 1);
  output = ''; await assert.rejects(ai.refineDraft(draft, settings), e => e.code === 'EMPTY_AI_REPLY');
  output = '가'.repeat(301); await assert.rejects(ai.refineDraft(draft, settings, 300), /300/);
  for (const [status, code] of [[401, 'AI_AUTH'], [429, 'AI_LIMIT'], [404, 'AI_MODEL'], [503, 'AI_CONNECTION']]) {
    ai.createClient = () => ({ responses: { create: async () => { throw { status }; } } });
    await assert.rejects(ai.refineDraft(draft, settings), e => e.code === code);
  }
  await assert.rejects(new ReplyAI('').refineDraft(draft, settings), e => e.code === 'API_KEY_REQUIRED');
});

test('all writable review channels refine unsaved text with scoped settings without saving or sending', async t => {
  const store = new Store(await directory(t)); await store.init();
  store.data.settings = { ...settings, delivery: { 'baemin-besti': { tone: '밝게', guidance: '매장 지침' } } };
  for (const platform of replyPlatforms) {
    const row = { ...review, platform, id: platform + '-review' }; store.data.reviews.push(row); store.data.drafts[row.id] = { text: '저장돼 있던 초안' };
    let seen;
    const service = new ReviewService(store, { publish: () => assert.fail('no send') }, { generate: () => assert.fail('no generation'), refineDraft: async (...args) => { seen = args; return refined; } }, platform);
    const result = await service.suggest(row.id, '  간결하게  ', { text: draft }); assert.equal(result.text, refined);
    assert.equal(seen[0], draft); assert.equal(seen[1].tone, '간결하게'); assert.equal(seen[2], platform.startsWith('coupangeats-') ? 300 : 1000);
    if (platform === 'baemin-besti') { assert.equal(seen[1].brand, '베스티'); assert.equal(seen[1].guidance, '매장 지침'); }
    assert.equal(store.data.drafts[row.id].text, '저장돼 있던 초안'); assert.equal(service.intents.size, 0);
    await assert.rejects(service.suggest(row.id, undefined, {}), e => e.code === 'INVALID_REFINEMENT_DRAFT');
    row.hasReply = true; await assert.rejects(service.suggest(row.id, undefined, { text: draft }), e => e.code === 'ALREADY_REPLIED');
  }
  assert.deepEqual(store.data.submissions, {});
  store.data.reviews.push({ ...review, platform: 'coupang', id: 'readonly' });
  await assert.rejects(new ReviewService(store, {}, {}, 'coupang').suggest('readonly', undefined, { text: draft }), e => e.code === 'READ_ONLY_REVIEW');
});

test('a review answered during refinement discards the result', async t => {
  const store = new Store(await directory(t)); await store.init(); store.data.reviews = [{ ...review }];
  const service = new ReviewService(store, {}, { refineDraft: async () => { store.data.reviews[0].hasReply = true; return refined; } });
  await assert.rejects(service.suggest(review.id, undefined, { text: draft }), e => e.code === 'ALREADY_REPLIED');
});

test('inquiry refinement shares busy/stale checks, frees seller queue and never sends or completes', async t => {
  const row = structuredClone(inquiry), adapter = { list: async () => ({ store: row.store, records: [structuredClone(row)] }), detail: async () => structuredClone(row), reply: () => assert.fail('no send'), complete: () => assert.fail('no completion') };
  const inbox = new AblyInquiryInbox(await directory(t), adapter); await inbox.init();
  const { records: [record] } = await inbox.list('goods', 'pending'); await inbox.draft(record.id, '저장된 원문');
  const started = deferred(), finish = deferred(); let seen;
  const ai = { configured: true, generateInquiry: () => assert.fail('no generation'), refineDraft: async (...args) => { seen = args; started.resolve(); await finish.promise; return refined; } };
  const pending = inbox.suggest(record.id, ai, settings, record.fingerprint, undefined, { text: draft }); await started.promise;
  await assert.rejects(inbox.suggest(record.id, ai, settings, record.fingerprint), e => e.code === 'INQUIRY_AI_BUSY');
  await inbox.detail(record.id); await inbox.draft(record.id, '다듬는 중 추가 작성');
  row.messages.push({ id: '2', role: 'customer', text: '추가 문의' }); finish.resolve();
  await assert.rejects(pending, e => e.code === 'INQUIRY_CHANGED');
  assert.equal(seen[0], draft); assert.equal(seen[1].brand, row.store); assert.equal(seen[2], 3000);
  assert.equal(inbox.data.drafts[record.id].text, '다듬는 중 추가 작성');
  assert.equal(inbox.generating.size, 0); assert.equal(inbox.intents.size, 0); assert.equal(inbox.completionIntents.size, 0);
  const fresh = await inbox.detail(record.id);
  assert.equal((await inbox.suggest(record.id, ai, settings, fresh.fingerprint, undefined, { text: draft })).text, refined);
  row.replyMode = 'confirm'; await assert.rejects(inbox.suggest(record.id, ai, settings, fresh.fingerprint, undefined, { text: draft }), e => e.code === 'INQUIRY_CONFIRM_ONLY');
});

test('review and all inquiry refinement HTTP routes enforce CSRF, reject missing text, and leave stored drafts intact', async t => {
  const dir = await directory(t), port = 14339, base = `http://127.0.0.1:${port}`, seen = [];
  const adapter = { list: async () => ({ store: inquiry.store, records: [structuredClone(inquiry)] }), detail: async () => structuredClone(inquiry) };
  const ai = { configured: true, refineDraft: async (...args) => { seen.push(args); return refined; } };
  const app = await createApp({ directory: dir, port, ai, maintenanceInterval: 0, inquiryAdapter: adapter, coupangInquiryAdapter: adapter, ablyInquiryAdapter: adapter });
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); });
  await app.store.update(s => { s.reviews = [{ ...review }]; s.drafts[review.id] = { text: '저장된 리뷰 초안' }; });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const post = (route, data, token = app.csrf) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Review-Token': token }, body: JSON.stringify(data) });
  const routes = [{ route: `/api/reviews/${review.id}`, data: {} }];
  for (const platform of ['naver', 'coupang', 'ably']) {
    const { records: [row] } = await (await post(`/api/inquiries/${platform}/list`, { category: 'goods', period: '1m' })).json();
    routes.push({ route: `/api/inquiries/${platform}/${row.id}`, data: { fingerprint: row.fingerprint } });
  }
  for (const { route, data } of routes) {
    assert.equal((await post(route + '/refine', { ...data, text: draft }, 'wrong')).status, 403);
    for (const value of [undefined, null, {}, '  ']) assert.equal((await post(route + '/refine', { ...data, text: value })).status, 400);
    assert.equal((await post(route + '/refine', { ...data, text: draft, tone: '간결하게' })).status, 200);
  }
  assert.equal(seen.length, 4); assert.ok(seen.every(args => args[0] === draft && args[1].tone === '간결하게'));
  assert.equal(app.store.data.drafts[review.id].text, '저장된 리뷰 초안'); assert.deepEqual(app.store.data.submissions, {});
});
