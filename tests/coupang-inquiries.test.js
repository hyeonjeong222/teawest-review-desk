import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { CoupangInquiryAdapter, parseCoupangInquiryCounts, parseCoupangSeller, normalizeCoupangCustomer, normalizeCoupangCenter, coupangInquiryRange, coupangConfirmationText } from '../src/coupang-inquiries.js';
import { InquiryInbox } from '../src/inquiry-inbox.js';
import { createApp } from '../src/server.js';
import { cleanupTestDirectory } from './cleanup.js';

const account = { store: '테스트', storeId: 'A0001' };
const customer = (id = 123, replies = []) => ({ productInquiryId: id, productId: 234, vendorItemId: 345, inquiryAt: Date.parse('2026-11-18T01:00:00Z'), content: '배송 <문의>', itemName: '상품', memberBasicInfo: { memberName: '고객' }, answerList: replies });
const center = (mode = 'NEED_REPLY') => ({ inquiry_id: 456, inquiry_type: '배송 확인', process_status: 'UNANSWERED', comment_type: mode, transferred_at: '2026-11-18T01:00:00Z', order: { order_id: 123456, customer_name: '고객', representative_item_name: '상품' }, comments: [{ id: 100, body: '출고 여부를 확인해 주세요.', author_name: '쿠팡 고객센터', created_at: '2026-11-18T01:00:00Z' }] });
async function folder(t) { const directory = await mkdtemp(path.join(os.tmpdir(), 'review-desk-test-coupang-inquiry-')); t.after(() => cleanupTestDirectory(directory)); return directory; }

test('Coupang summary rejects unknown counts and preserves the exact 30-day scope', () => {
  const valid = { targetDay: 30, csUnansweredInquiry: { count: 0 }, productUnansweredInquiry: { count: 2 } };
  assert.deepEqual(parseCoupangInquiryCounts(valid).map(r => r.count), [0, 2]);
  for (const value of [null, undefined, '', '0', -1, 0.5]) assert.throws(() => parseCoupangInquiryCounts({ ...valid, csUnansweredInquiry: { count: value } }), e => e.code === 'COUPANG_INQUIRY_LAYOUT');
  assert.throws(() => parseCoupangInquiryCounts({ ...valid, targetDay: 31 }));
  assert.deepEqual(coupangInquiryRange('1m', new Date('2026-11-17T16:00:00Z')), { from: '2026-10-20', to: '2026-11-18', period: '1m' });
  assert.throws(() => coupangInquiryRange('1y'));
});
test('server identity is parsed as data without executing scripts or accepting missing vendors', () => {
  assert.deepEqual(parseCoupangSeller("<script>window.__GLOBAL_DATA__ = {vendorId: 'A0001', vendorName: '테스트', arbitrary: throwError()};</script>"), account);
  assert.throws(() => parseCoupangSeller('<html>로그인</html>'));
});
test('customer and center records retain text, restrict completed replies and distinguish confirmation-only work', () => {
  const r = normalizeCoupangCustomer(customer()); assert.equal(r.content, '배송 <문의>'); assert.equal(r.canReply, true); assert.equal(r.replyLimit, 2000);
  const answered = normalizeCoupangCustomer(customer(123, [{ inquiryId: 123, inquiryCommentId: 999, inquiryCommentAt: Date.now(), content: '내일 출고합니다.' }]));
  assert.equal(answered.canReply, false); assert.equal(answered.messages[1].role, 'seller');
  assert.throws(() => normalizeCoupangCustomer(customer(123, [{ inquiryId: 999, inquiryCommentId: 999, content: '잘못된 문의' }])));
  const confirm = normalizeCoupangCenter(center('CONFIRM'), true); assert.equal(confirm.replyMode, 'confirm'); assert.equal(confirm.confirmationText, coupangConfirmationText); assert.equal(confirm.canReply, true);
  assert.equal(normalizeCoupangCenter({ ...center(), process_status: 'ANSWER_COMPLETED' }, true).canReply, false);
  assert.equal(normalizeCoupangCenter(center('NO_NEED_COMMENT'), true).canReply, false);
  assert.throws(() => normalizeCoupangCenter(center('UNKNOWN'), true));
});
test('Coupang paginates bounded date windows and does not accept incomplete or repeated pages', async () => {
  const a = new CoupangInquiryAdapter({}); a.identity = async () => account;
  const calls = []; a.request = async (endpoint, body) => { calls.push({ endpoint, body }); return { success: true, data: { content: [], pagination: { currentPage: body.pageNum || body.page, totalPages: 0, totalElements: 0 } } }; };
  const result = await a.list('customer', '3m'); assert.equal(result.records.length, 0); assert.equal(calls.length, 4);
  for (const { body } of calls) { assert.ok((Date.parse(body.endTime.replaceAll('.', '-')) - Date.parse(body.startTime.replaceAll('.', '-'))) / 86400000 < 28); assert.equal(body.inquiryState, 'ALL'); }
  calls.length = 0; await a.list('center', '1m'); assert.equal(calls[0].body.pageNum, 1); assert.deepEqual(calls[0].body.processStatusList, ['all']);
  a.request = async () => ({ success: true, data: { content: [customer()], pagination: { currentPage: 0, totalPages: 1, totalElements: 2 } } });
  await assert.rejects(a.list('customer', '1m'), e => e.code === 'COUPANG_INQUIRY_LAYOUT');
});
test('reply requests use observed payloads only after persistence and target the selected inquiry', async () => {
  const a = new CoupangInquiryAdapter({}), calls = []; a.identity = async () => account;
  a.request = async (endpoint, body) => { assert.equal(calls.at(-1), 'persist'); calls.push({ endpoint, body }); return { success: true, data: { commentId: 987, id: 988 } }; };
  const reply = await a.reply({ ...normalizeCoupangCustomer(customer()), ...account }, '내일 출고됩니다.', async () => calls.push('persist'));
  assert.equal(reply.messageId, '987'); assert.deepEqual(calls.at(-1), { endpoint: '/tenants/cs/product/inquiries/comment', body: { inquiryId: 123, content: '내일 출고됩니다.' } });
  await a.reply({ ...normalizeCoupangCenter(center(), true), ...account }, '확인했습니다.', async () => calls.push('persist'));
  assert.deepEqual(calls.at(-1), { endpoint: '/tenants/cs/csinquiry/comment', body: { ticket_id: 456, ticket_comment: { body: '확인했습니다.', tokens: [] } } });
  await assert.rejects(a.reply({ ...normalizeCoupangCenter(center('CONFIRM'), true), ...account }, '임의 답변', () => assert.fail()));
  await assert.rejects(a.reply({ ...normalizeCoupangCustomer(customer()), ...account }, '가'.repeat(2001), () => assert.fail()));
});
test('server account switches stop replies even when an old browser tab is still signed in', async () => {
  const connector = { status: async () => ({ connected: true }), getPage: async () => ({ context: () => ({ request: { get: async () => ({ status: () => 200, text: async () => "window.__GLOBAL_DATA__ = { vendorId: 'A0002', vendorName: '테스트' };", dispose: async () => {} }) } }) }) };
  const a = new CoupangInquiryAdapter(connector); let sends = 0; a.request = async () => sends++;
  await assert.rejects(a.reply({ ...normalizeCoupangCustomer(customer()), ...account }, '오발송 금지', () => assert.fail()), e => e.code === 'STORE_CHANGED'); assert.equal(sends, 0);
});
test('center receipts reconcile exact new comments; wrong receipt and old identical text never count as success', async t => {
  const directory = await folder(t); let row = { ...normalizeCoupangCenter(center('CONFIRM'), true), ...account }, sends = 0;
  const adapter = { list: async () => ({ records: [row] }), detail: async () => structuredClone(row), reply: async (record, text, before) => { await before(); sends++; row.messages.push({ id: '200', role: 'system', text }); return { messageId: '200' }; } };
  const service = new InquiryInbox(directory, adapter, undefined, { filename: 'coupang-inquiries.json' }); await service.init(); const id = (await service.list('center')).records[0].id;
  const detail = await service.detail(id); await assert.rejects(service.prepare(id, '다른 내용', detail.fingerprint), e => e.code === 'INQUIRY_CONFIRM_ONLY');
  const intent = await service.prepare(id, coupangConfirmationText, detail.fingerprint); assert.equal(sends, 0);
  assert.equal((await service.publish(id, intent.token)).sent, true); assert.equal(sends, 1);
  await assert.rejects(service.publish(id, intent.token), e => e.code === 'INQUIRY_INTENT_EXPIRED');
  adapter.reply = async (record, text, before) => { await before(); sends++; return { messageId: '201' }; };
  const next = await service.detail(id), second = await service.prepare(id, coupangConfirmationText, next.fingerprint);
  await assert.rejects(service.publish(id, second.token), e => e.code === 'INQUIRY_UNCERTAIN');
  const restarted = new InquiryInbox(directory, adapter, undefined, { filename: 'coupang-inquiries.json' }); await restarted.init();
  assert.equal((await restarted.detail(id)).attempt.state, 'uncertain'); assert.equal(sends, 2);
});
test('HTTP separates platforms, requires CSRF and preserves Naver drafts while Coupang publishes', async t => {
  const directory = await folder(t), port = 14331, base = `http://127.0.0.1:${port}`;
  const row = { ...normalizeCoupangCustomer(customer()), ...account }; let sends = 0;
  const adapter = { list: async () => ({ records: [structuredClone(row)] }), detail: async () => structuredClone(row), reply: async (r, text, before) => { await before(); sends++; row.messages.push({ id: '999', role: 'seller', text }); row.canReply = false; row.status = 'answered'; return { messageId: '999' }; } };
  const app = await createApp({ directory, port, maintenanceInterval: 0, coupangInquiryAdapter: adapter, inquiryAdapter: { list: async () => ({ records: [{ ...row, platform: 'naver', storeId: undefined }] }) } });
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }); app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const post = (platform, route, data, token = app.csrf) => fetch(`${base}/api/inquiries/${platform}/${route}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Review-Token': token }, body: JSON.stringify(data) });
  const naver = await (await post('naver', 'list', { category: 'customer' })).json(), nid = naver.records[0].id;
  await post('naver', nid + '/draft', { text: '네이버 초안 유지' });
  const listed = await (await post('coupang', 'list', { category: 'customer' })).json(), id = listed.records[0].id;
  assert.equal((await post('coupang', nid + '/detail', {})).status, 404);
  assert.equal((await post('coupang', id + '/prepare', {}, 'wrong')).status, 403);
  const detail = await (await post('coupang', id + '/detail', {})).json(), intent = await (await post('coupang', id + '/prepare', { text: '내일 출고 예정입니다.', fingerprint: detail.fingerprint })).json();
  assert.equal(sends, 0); assert.equal((await post('coupang', id + '/publish', { token: intent.token })).status, 200); assert.equal(sends, 1);
  assert.match(await readFile(path.join(directory, 'inquiries.json'), 'utf8'), /네이버 초안 유지/);
});
