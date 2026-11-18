import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { NaverInquiryInbox } from '../src/naver-inquiry-inbox.js';
import { NaverInquiryAdapter, parseSellerJSON, inquiryRange } from '../src/naver-inquiry-adapter.js';
import { AppError } from '../src/core.js';
import { createApp } from '../src/server.js';
import { cleanupTestDirectory } from './cleanup.js';

const record = () => ({ store: '테스트 매장', category: 'customer', sourceId: '123', title: '배송 문의', product: '테스트 상품', author: '고객', content: '언제 출고되나요?', date: '2026-11-18', status: 'pending', canReply: true, messages: [{ id: '1', role: 'customer', text: '언제 출고되나요?' }], meta: { alarmType: 'NONE', commentId: '' }, detailed: true });
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-desk-test-inquiry-')); t.after(() => cleanupTestDirectory(directory));
  let row = record(), sends = 0, fail = false;
  const adapter = {
    list: async () => ({ records: [structuredClone(row)], store: row.store, checkedAt: new Date().toISOString() }),
    detail: async () => structuredClone(row),
    reply: async (r, text, beforeSend) => { await beforeSend(); sends++; if (fail) throw new Error('Connection lost'); row.messages.push({ id: String(sends + 100), role: 'seller', text }); row.status = 'answered'; row.canReply = false; },
  };
  const service = new NaverInquiryInbox(directory, null, undefined, adapter); await service.init();
  const result = await service.list('customer', '3m'), id = result.records[0].id;
  return { service, adapter, directory, id, row, sends: () => sends, fail: () => { fail = true; } };
}
test('confirmed inquiry sends only approved text once, reads it back and preserves other drafts', async t => {
  const { service, id, sends } = await setup(t);
  await service.draft(id, '내일 출고됩니다.'); await service.update(s => { s.drafts.other = { text: '다른 문의 초안' }; });
  const detail = await service.detail(id), intent = await service.prepare(id, '내일 출고됩니다.', detail.fingerprint);
  assert.equal(sends(), 0); assert.equal(intent.inquiry.meta, undefined);
  const results = await Promise.allSettled([service.publish(id, intent.token), service.publish(id, intent.token)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'INQUIRY_INTENT_EXPIRED'); assert.equal(sends(), 1);
  assert.equal(service.data.attempts[id].state, 'sent'); assert.equal(service.data.drafts[id], undefined); assert.equal(service.data.drafts.other.text, '다른 문의 초안');
  assert.equal(results[0].value.inquiry.messages.at(-1).text, '내일 출고됩니다.');
});
test('an uncertain send survives restart, does not match an old identical reply and cannot resend', async t => {
  const { service, adapter, directory, id, row, fail, sends } = await setup(t);
  row.messages.push({ id: 'old', role: 'seller', text: '같은 답변입니다.' });
  await service.draft(id, '같은 답변입니다.'); const detail = await service.detail(id), intent = await service.prepare(id, '같은 답변입니다.', detail.fingerprint); fail();
  await assert.rejects(service.publish(id, intent.token), e => e.code === 'INQUIRY_UNCERTAIN'); assert.equal(sends(), 1);
  const restarted = new NaverInquiryInbox(directory, null, undefined, adapter); await restarted.init();
  const latest = await restarted.detail(id); assert.equal(latest.attempt.state, 'uncertain');
  await assert.rejects(restarted.prepare(id, '다른 답변입니다.', latest.fingerprint), e => e.code === 'INQUIRY_UNCERTAIN'); assert.equal(sends(), 1);
  row.messages.push({ id: 'new', role: 'seller', text: '같은 답변입니다.' });
  assert.equal((await restarted.detail(id)).attempt.state, 'sent'); assert.equal(restarted.data.drafts[id], undefined);
});
test('changed content, store, expired intents and persistence failure all prevent sends', async t => {
  const { service, id, row, sends } = await setup(t);
  const detail = await service.detail(id);
  row.content = '추가 질문'; await assert.rejects(service.prepare(id, '안내드립니다.', detail.fingerprint), e => e.code === 'INQUIRY_CHANGED');
  const current = await service.detail(id), intent = await service.prepare(id, '안내드립니다.', current.fingerprint);
  row.messages.push({ id: '2', role: 'customer', text: '추가 문의' }); await assert.rejects(service.publish(id, intent.token), e => e.code === 'INQUIRY_CHANGED');
  row.store = '다른 스토어'; await assert.rejects(service.detail(id), e => e.code === 'INQUIRY_CHANGED'); row.store = '테스트 매장';
  const latest = await service.detail(id), expired = await service.prepare(id, '안내드립니다.', latest.fingerprint); service.intents.get(expired.token).expires = 0;
  await assert.rejects(service.publish(id, expired.token), e => e.code === 'INQUIRY_INTENT_EXPIRED');
  const valid = await service.prepare(id, '안내드립니다.', latest.fingerprint), update = service.update.bind(service); let writes = 0;
  service.update = fn => { if (++writes === 2) throw new Error('Disk full'); return update(fn); };
  await assert.rejects(service.publish(id, valid.token), /Disk full/); assert.equal(sends(), 0);
});
test('failed list refresh retains drafts and successful detail reads never erase edited text', async t => {
  const { service, adapter, id } = await setup(t); await service.draft(id, '작성 중입니다.');
  adapter.list = async () => { throw new AppError('조회 실패', 502); };
  await assert.rejects(service.list('customer', '3m')); assert.equal(service.data.drafts[id].text, '작성 중입니다.');
  assert.equal((await service.detail(id)).draft, '작성 중입니다.');
});
test('observed seller payloads stay scoped to the selected inquiry and only send after the durable callback', async () => {
  const calls = [], connector = { status: async () => ({ connected: true, store: '테스트 매장' }), getPage: async () => ({ request: { fetch: async (url, options) => { calls.push({ url, options }); return { status: () => 200, ok: () => true, text: async () => JSON.stringify(url.endsWith('/inquiries') ? { talkAccountId: 'account' } : { bSuccess: true }), dispose: async () => {} }; } } }) };
  const adapter = new NaverInquiryAdapter(connector);
  for (const category of ['customer', 'product', 'center', 'talktalk']) {
    const row = { ...record(), category, meta: category === 'product' ? { contentsName: '상품', contentsObjectId: '456', commentType: 'PRODUCT', secret: true, storeType: 'STOREFARM', productNo: 456 } : category === 'talktalk' ? { account: 'account' } : { alarmType: 'NONE', commentId: '' } };
    let persisted = false; const before = calls.length;
    await adapter.reply(row, '확인한 답변', async () => { persisted = true; calls.push('persist'); });
    assert.equal(persisted, true); const send = calls.at(-1); assert.equal(calls.at(-2), 'persist'); assert.equal(send.options.method, 'POST');
    if (category === 'customer') { assert.equal(send.options.form['id.inquiryNo'], '123'); assert.equal(send.options.form.content, '확인한 답변'); }
    if (category === 'product') { assert.equal(send.options.data.parentCommentId, 123); assert.equal(send.options.data.secret, true); }
    if (category === 'center') { assert.ok(send.url.endsWith('/123/messages/answer')); assert.deepEqual(send.options.data, { body: '확인한 답변' }); }
    if (category === 'talktalk') { assert.ok(send.url.endsWith('/account/chat/123/send')); assert.deepEqual(JSON.parse(send.options.multipart.jsonMessageList), [{ textContent: { text: '확인한 답변' } }]); }
    assert.ok(calls.length > before);
  }
  connector.status = async () => ({ connected: true, store: '다른 매장' }); const count = calls.length;
  await assert.rejects(adapter.reply(record(), '잘못된 대상', () => assert.fail()), e => e.code === 'STORE_CHANGED'); assert.equal(calls.length, count);
});
test('legacy JSON normalization is narrow and dates follow Korea time', () => {
  assert.deepEqual(parseSellerJSON('{"answerSatisfactionYn":\'-\',"title":"<script>text</script>"}'), { answerSatisfactionYn: '-', title: '<script>text</script>' });
  assert.throws(() => parseSellerJSON('{"value":process.exit()}'), e => e.code === 'INQUIRY_LAYOUT');
  assert.equal(inquiryRange('1m', new Date('2026-11-17T16:00:00Z')).to, '2026-11-18'); assert.throws(() => inquiryRange('1y'));
});
test('HTTP inbox keeps review storage separate and requires CSRF plus a one-time intent', async t => {
  const { adapter, directory, sends } = await setup(t), port = 14330, base = `http://127.0.0.1:${port}`;
  const connector = { status: async () => ({ connected: true, store: '테스트 매장' }) };
  const app = await createApp({ directory, connector, inquiryAdapter: adapter, port, maintenanceInterval: 0 });
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const before = JSON.stringify(app.store.data), post = (route, data, csrf = app.csrf) => fetch(base + '/api/inquiries/naver/' + route, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Review-Token': csrf }, body: JSON.stringify(data) });
  assert.equal((await post('list', {}, 'wrong')).status, 403);
  const listed = await (await post('list', { category: 'customer', period: '3m' })).json(), id = listed.records[0].id;
  assert.equal((await post(id + '/publish', { token: 'guessed' })).status, 409);
  const detail = await (await post(id + '/detail', {})).json(), intent = await (await post(id + '/prepare', { text: '내일 출고됩니다.', fingerprint: detail.fingerprint })).json();
  assert.equal(sends(), 0); assert.equal((await post(id + '/publish', { token: intent.token }, 'wrong')).status, 403);
  assert.equal((await post(id + '/publish', { token: intent.token })).status, 200); assert.equal(sends(), 1);
  assert.equal(JSON.stringify(app.store.data), before); assert.match(await readFile(path.join(directory, 'inquiries.json'), 'utf8'), /내일 출고됩니다/);
});
