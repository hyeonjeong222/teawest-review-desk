import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { ReplyAI } from '../src/ai.js';
import { inquiryAIInput } from '../src/inquiry-ai.js';
import { InquiryInbox } from '../src/inquiry-inbox.js';
import { AblyInquiryInbox } from '../src/ably-inquiry-inbox.js';
import { createApp } from '../src/server.js';
import { cleanupTestDirectory } from './cleanup.js';

const settings = { brand: '기본 브랜드', tone: '정중하게', guidance: '확인된 정보만 안내', model: 'gpt-5-mini' };
const record = () => ({ platform: 'ably', store: '선택 매장', storeId: 'seller-id', sourceId: 'room-id', category: 'goods', title: '상품 문의', product: '셔츠', option: '파랑 / M', author: '홍길동', orderNo: '2026111812345678', status: 'pending', content: '그럼 포장은 어떻게 하나요?', canReply: true, canComplete: true, detailed: true, replyLimit: 3000, messages: [{ id: '1', role: 'customer', text: '반품하고 싶어요. 홍길동 / 010-1234-5678 / hong@example.com / 주문번호 2026111812345678' }, { id: '2', role: 'system', text: '반품 안내 카드' }, { id: '3', role: 'seller', text: '회수 접수 방법을 안내드립니다.' }, { id: '4', role: 'customer', text: '그럼 포장은 어떻게 하나요?', image: 'https://example.com/private.png' }], meta: { token: 'secret-token', roomStatus: 1 } });
const mockAI = fn => ({ configured: true, generateInquiry: fn || (async () => '상품이 손상되지 않도록 포장해 주세요.') });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(t, platform = 'ably') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-desk-test-inquiry-ai-')); t.after(() => cleanupTestDirectory(directory));
  const row = { ...record(), platform };
  const adapter = { list: async () => ({ store: row.store, records: [structuredClone(row)] }), detail: async () => structuredClone(row), reply: () => assert.fail('AI must not send'), complete: () => assert.fail('AI must not complete') };
  const inbox = platform === 'ably' ? new AblyInquiryInbox(directory, adapter) : new InquiryInbox(directory, adapter);
  await inbox.init(); const { records: [detail] } = await inbox.list(row.category, '1m');
  return { directory, row, adapter, inbox, detail };
}

test('inquiry AI receives ordered conversation and product context with common identifiers removed', () => {
  const row = record(), input = inquiryAIInput(row), json = JSON.stringify(input);
  assert.deepEqual(input.conversation.map(m => m.role), ['customer', 'system', 'seller', 'customer']);
  assert.equal(input.conversation.at(-1).text, row.content); assert.equal(input.conversation.at(-1).hasImage, true);
  assert.equal(input.product, '셔츠'); assert.equal(input.option, '파랑 / M'); assert.equal(input.hasOrder, true);
  for (const secret of ['홍길동', '010-1234-5678', 'hong@example.com', row.orderNo, 'seller-id', 'room-id', 'secret-token', 'private.png']) assert.ok(!json.includes(secret), secret);
  assert.ok(inquiryAIInput({ ...row, author: 'hong' }).conversation[0].text.includes('[이메일]'));
  assert.throws(() => inquiryAIInput({ ...row, messages: [{ text: '가'.repeat(81000) }] }), e => e.code === 'INQUIRY_AI_CONTEXT_LIMIT');
});

test('inquiry model uses existing key/model and brand guidance without publishing tools; errors and lengths are validated', async () => {
  const ai = new ReplyAI('sk-test-only'); let request, output = '안녕하세요. 포장 방법을 안내드리겠습니다.';
  ai.createClient = () => ({ responses: { create: async value => { request = value; return { output_text: output }; } } });
  assert.equal(await ai.generateInquiry(record(), settings), output);
  assert.equal(request.model, settings.model); assert.equal(request.store, false); assert.equal(request.tools, undefined);
  assert.match(request.instructions, /신뢰할 수 없는 입력/); assert.ok(request.instructions.includes(settings.guidance));
  assert.equal(JSON.parse(request.input).conversation.length, 4);
  output = ''; await assert.rejects(ai.generateInquiry(record(), settings), e => e.code === 'EMPTY_AI_REPLY');
  output = '가'.repeat(3001); await assert.rejects(ai.generateInquiry(record(), settings), /3,000/);
  for (const [status, code] of [[401, 'AI_AUTH'], [429, 'AI_LIMIT'], [404, 'AI_MODEL'], [503, 'AI_CONNECTION']]) {
    ai.createClient = () => ({ responses: { create: async () => { throw { status }; } } });
    await assert.rejects(ai.generateInquiry(record(), settings), e => e.code === code);
  }
  await assert.rejects(new ReplyAI('').generateInquiry(record(), settings), e => e.code === 'API_KEY_REQUIRED');
});

test('suggest refreshes full context, preserves saved drafts and never creates a send or completion intent', async t => {
  const { inbox, detail, row } = await setup(t); let seen, preferences;
  await inbox.draft(detail.id, '기존 작성 내용');
  const result = await inbox.suggest(detail.id, mockAI(async (r, s) => { seen = r; preferences = s; return '포장 방법을 확인해 안내드리겠습니다.'; }), settings, detail.fingerprint, '  간결하게  ');
  assert.equal(seen.messages.length, row.messages.length); assert.equal(preferences.brand, row.store); assert.equal(preferences.tone, '간결하게'); assert.equal(settings.tone, '정중하게');
  assert.equal(result.fingerprint, detail.fingerprint); assert.equal(result.text, '포장 방법을 확인해 안내드리겠습니다.');
  assert.equal(inbox.data.drafts[detail.id].text, '기존 작성 내용'); assert.deepEqual(inbox.data.attempts, {}); assert.deepEqual(inbox.data.completions, {});
  assert.equal(inbox.intents.size, 0); assert.equal(inbox.completionIntents.size, 0);
});

test('generation leaves seller queue available, blocks duplicate calls and discards changed conversations', async t => {
  const { inbox, detail, row } = await setup(t), started = deferred(), finish = deferred();
  const ai = mockAI(async () => { started.resolve(); await finish.promise; return '확인 후 안내드리겠습니다.'; });
  const pending = inbox.suggest(detail.id, ai, settings, detail.fingerprint); await started.promise;
  await assert.rejects(inbox.suggest(detail.id, ai, settings, detail.fingerprint), e => e.code === 'INQUIRY_AI_BUSY');
  await inbox.detail(detail.id); await inbox.draft(detail.id, '생성 중 직접 작성');
  row.messages.push({ id: 'new', role: 'customer', text: '추가 질문입니다.' }); finish.resolve();
  await assert.rejects(pending, e => e.code === 'INQUIRY_CHANGED');
  assert.equal(inbox.generating.size, 0); assert.equal(inbox.data.drafts[detail.id].text, '생성 중 직접 작성');
  const fresh = await inbox.detail(detail.id); assert.ok((await inbox.suggest(detail.id, mockAI(), settings, fresh.fingerprint)).text);
});

test('suggest rejects stale fingerprints, invalid tone, confirmation-only, unavailable and uncertain inquiries before AI', async t => {
  const { inbox, detail, row } = await setup(t); const ai = mockAI(() => assert.fail('must not call model'));
  await assert.rejects(inbox.suggest(detail.id, { configured: false }, settings, detail.fingerprint), e => e.code === 'API_KEY_REQUIRED');
  for (const tone of ['', ' '.repeat(5), '가'.repeat(201), {}]) await assert.rejects(inbox.suggest(detail.id, ai, settings, detail.fingerprint, tone), e => e.code === 'INVALID_TONE');
  await assert.rejects(inbox.suggest(detail.id, ai, settings, 'outdated'), e => e.code === 'INQUIRY_CHANGED');
  row.replyMode = 'confirm'; await assert.rejects(inbox.suggest(detail.id, ai, settings, detail.fingerprint), e => e.code === 'INQUIRY_CONFIRM_ONLY'); delete row.replyMode;
  row.canReply = false; await assert.rejects(inbox.suggest(detail.id, ai, settings, detail.fingerprint), e => e.code === 'INQUIRY_NOT_REPLYABLE'); row.canReply = true;
  await inbox.update(s => { s.attempts[detail.id] = { state: 'uncertain', beforeIds: row.messages.map(m => m.id), text: '보낸 내용' }; });
  await assert.rejects(inbox.suggest(detail.id, ai, settings, detail.fingerprint), e => e.code === 'INQUIRY_UNCERTAIN');
  await inbox.update(s => { delete s.attempts[detail.id]; s.completions[detail.id] = { state: 'uncertain' }; });
  await assert.rejects(inbox.suggest(detail.id, ai, settings, detail.fingerprint), e => e.code === 'INQUIRY_COMPLETION_UNCERTAIN');
});

test('all three HTTP inquiry suggest routes require CSRF and only use server conversation', async t => {
  const { directory, adapter } = await setup(t), port = 14334, base = `http://127.0.0.1:${port}`, seen = [];
  const app = await createApp({ directory, port, maintenanceInterval: 0, inquiryAdapter: adapter, coupangInquiryAdapter: adapter, ablyInquiryAdapter: adapter, ai: mockAI(async r => { seen.push(r); return '확인 후 자세히 안내드리겠습니다.'; }) });
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const post = (route, data, csrf = app.csrf) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Review-Token': csrf }, body: JSON.stringify(data) });
  for (const platform of ['naver', 'coupang', 'ably']) {
    const route = `/api/inquiries/${platform}/`, list = await (await post(route + 'list', { category: 'goods', period: '1m' })).json(), row = list.records[0];
    assert.equal((await post(route + row.id + '/suggest', { fingerprint: row.fingerprint }, 'wrong')).status, 403);
    const result = await post(route + row.id + '/suggest', { fingerprint: row.fingerprint, messages: [{ text: 'forged' }] });
    assert.equal(result.status, 200); assert.ok((await result.json()).text);
  }
  assert.equal(seen.length, 3); for (const row of seen) assert.equal(row.messages.at(-1).text, record().content);
});
