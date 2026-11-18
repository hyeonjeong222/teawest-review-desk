import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { AblyInquiryAdapter, ablyInquiryCategories, parseAblyInquiryCounts, normalizeAblyRoom, normalizeAblyMessage, ablyCardText } from '../src/ably-inquiries.js';
import { AblyInquiryInbox } from '../src/ably-inquiry-inbox.js';
import { InquiryInbox } from '../src/inquiry-inbox.js';
import { createApp } from '../src/server.js';
import { cleanupTestDirectory } from './cleanup.js';

const account = { store: '테스트', storeId: '600' };
const room = (sno = 100, child = 16) => ({ sno, market: { sno: 600, name: '테스트' }, member: { sno: 20, name: '고객' }, is_ably: false, status: 1, parent_category: 10, child_category: child, parent_category_display: '주문', child_category_display: '반품', created_at: '2026-11-18T13:00:00', updated_latest_message_at: '2026-11-18T13:00:00', latest_message: { content: '회수 일정 문의' } });
const message = (sno = 300, role = 'USER', content = '회수 일정 문의') => ({ sno, type: 1, member_type: role, is_written_by_system: false, content, created_at: '2026-11-18T13:00:00+09:00', deleted_at: null });
const row = () => normalizeAblyRoom(room(), account, { detailed: true, messages: [normalizeAblyMessage(message())] });
async function folder(t) { const directory = await mkdtemp(path.join(os.tmpdir(), 'review-desk-test-ably-inquiry-')); t.after(() => cleanupTestDirectory(directory)); return directory; }
const mockAdapter = () => { const a = new AblyInquiryAdapter({}); a.identity = async () => ({ session: {}, ...account }); return a; };

test('Ably counts distinguish all seven categories and reject unknown or missing counts', () => {
  const counts = Object.fromEntries(ablyInquiryCategories.map((c, i) => [c.id, i]));
  assert.deepEqual(parseAblyInquiryCounts(counts).map(c => c.count), [0, 1, 2, 3, 4, 5, 6]);
  for (const value of [undefined, null, '', false, -1, 1.5]) assert.throws(() => parseAblyInquiryCounts({ ...counts, goods: value }));
  for (const [code, category] of [[2, 'goods'], [126, 'order_before_delivery'], [16, 'order_after_delivery'], [19, 'order_etc'], [153, 'place'], [172, 'affiliate_sponsorship'], [999, 'etc']]) assert.equal(normalizeAblyRoom(room(100, code), account).category, category);
});
test('Ably conversations preserve Korean time, text, roles and platform restrictions', () => {
  assert.equal(normalizeAblyMessage(message()).date, '2026-11-18T04:00:00.000Z');
  assert.equal(normalizeAblyMessage(message(301, 'SELLER', '<b>답변</b>')).text, '<b>답변</b>');
  assert.equal(normalizeAblyMessage({ ...message(301, 'SELLER'), is_written_by_system: true }).role, 'system');
  assert.equal(normalizeAblyMessage({ ...message(301, 'SELLER'), deleted_at: '2026-11-18' }).role, 'system');
  for (const status of [0, 4, 5]) assert.equal(normalizeAblyRoom({ ...room(), status }, account, { detailed: true }).canReply, false);
  for (const status of [1, 2, 3]) assert.equal(normalizeAblyRoom({ ...room(), status }, account, { detailed: true }).canReply, true);
  assert.equal(normalizeAblyRoom({ ...room(), is_ably: true }, account, { detailed: true }).canReply, false);
  assert.equal(normalizeAblyRoom({ ...room(), order_item: { delivery_type: 'third_pl' } }, account, { detailed: true }).canReply, false);
  assert.throws(() => normalizeAblyRoom({ ...room(), market: { sno: 601, name: '테스트' } }, account), e => e.code === 'STORE_CHANGED');
});
test('Ably cards expose display text without actions and images use only the approved host', () => {
  const card = { sections: [{ type: 'HTML', contents: { text: '<b>반품 안내</b><br>문 앞에 놓아 주세요.&nbsp;&#x1f4e6;<script>bad()</script>' } }, { type: 'BUTTON', contents: { text: '문의 계속하기' }, actions: [{ url: 'javascript:bad()' }] }] };
  assert.equal(ablyCardText(card), '반품 안내\n문 앞에 놓아 주세요. 📦\n\n선택 항목: 문의 계속하기');
  const m = normalizeAblyMessage({ ...message(301, 'SELLER'), type: 5, content: null, is_written_by_system: true, card });
  assert.equal(m.label, '자동 안내'); assert.match(m.text, /반품 안내/); assert.equal(m.actions, undefined); assert.equal(m.role, 'system');
  const picture = normalizeAblyMessage({ ...message(), type: 2, content: null, image_url: 'https://d3ha2047wt6x28.cloudfront.net/photo.jpg' }); assert.ok(picture.image);
  for (const url of ['javascript:bad()', 'https://example.com/photo.jpg', 'https://user@d3ha2047wt6x28.cloudfront.net/photo.jpg']) assert.equal(normalizeAblyMessage({ ...message(), type: 2, content: null, image_url: url }).image, undefined);
  assert.equal(normalizeAblyMessage({ ...message(), type: 2, deleted_at: '2026-11-18', image_url: picture.image }).image, undefined);
});
test('Ably completion calls only the observed empty POST endpoint after persistence', async () => {
  const a = mockAdapter(), calls = []; let persisted = false;
  a.request = async (_, endpoint, answer, options) => { assert.equal(persisted, true); calls.push({ endpoint, answer, options }); return {}; };
  await a.complete(row(), async () => { persisted = true; });
  assert.deepEqual(calls, [{ endpoint: '/contact_rooms/100/complete/', answer: undefined, options: { method: 'POST' } }]);
  for (const status of [0, 3, 4, 5]) await assert.rejects(a.complete(normalizeAblyRoom({ ...room(), status }, account, { detailed: true }), () => assert.fail()), e => e.code === 'INQUIRY_NOT_COMPLETABLE');
  await assert.rejects(a.complete(normalizeAblyRoom({ ...room(), is_ably: true }, account, { detailed: true }), () => assert.fail()));
  assert.equal(calls.length, 1);
});
test('Ably completion requires a one-time intent, preserves drafts and rejects changed conversations', async t => {
  const directory = await folder(t), current = row(); let completions = 0;
  const adapter = { list: async () => ({ records: [structuredClone(current)] }), detail: async () => structuredClone(current), complete: async (_, before) => { await before(); const saved = JSON.parse(await readFile(path.join(directory, 'ably-inquiries.json'))); assert.equal(Object.values(saved.completions)[0].state, 'attempting'); completions++; current.status = 'answered'; current.statusLabel = '처리 완료'; current.canComplete = false; current.meta.roomStatus = 3; } };
  const inbox = new AblyInquiryInbox(directory, adapter); await inbox.init(); const id = (await inbox.list('order_after_delivery')).records[0].id; await inbox.draft(id, '보관할 초안');
  const detail = await inbox.detail(id), intent = await inbox.prepareComplete(id, detail.fingerprint); assert.equal(completions, 0);
  await assert.rejects(inbox.publish(id, intent.token), e => e.code === 'INQUIRY_INTENT_EXPIRED');
  const done = await inbox.complete(id, intent.token); assert.equal(done.completed, true); assert.equal(done.inquiry.draft, '보관할 초안'); assert.equal(done.inquiry.completionAttempt.state, 'completed'); assert.equal(completions, 1);
  await assert.rejects(inbox.complete(id, intent.token), e => e.code === 'INQUIRY_INTENT_EXPIRED');
  Object.assign(current, row()); const fresh = await inbox.detail(id), next = await inbox.prepareComplete(id, fresh.fingerprint);
  current.messages.push({ id: '990', role: 'customer', text: '추가 질문입니다.' });
  await assert.rejects(inbox.complete(id, next.token), e => e.code === 'INQUIRY_CHANGED'); assert.equal(completions, 1);
});
test('Ably uncertain completion survives restart, blocks repeat actions and reconciles by reading', async t => {
  const directory = await folder(t), current = row(); let completions = 0;
  const adapter = { list: async () => ({ records: [structuredClone(current)] }), detail: async () => structuredClone(current), complete: async (_, before) => { await before(); completions++; throw new Error('lost response'); } };
  const inbox = new AblyInquiryInbox(directory, adapter); await inbox.init(); const id = (await inbox.list('order_after_delivery')).records[0].id;
  const detail = await inbox.detail(id), intent = await inbox.prepareComplete(id, detail.fingerprint);
  await assert.rejects(inbox.complete(id, intent.token), e => e.code === 'INQUIRY_COMPLETION_UNCERTAIN');
  const resumed = new AblyInquiryInbox(directory, adapter); await resumed.init(); const pending = await resumed.detail(id);
  await assert.rejects(resumed.prepareComplete(id, pending.fingerprint), e => e.code === 'INQUIRY_COMPLETION_UNCERTAIN');
  await assert.rejects(resumed.prepare(id, '답변', pending.fingerprint), e => e.code === 'INQUIRY_COMPLETION_UNCERTAIN');
  current.status = 'answered'; current.canComplete = false; current.meta.roomStatus = 3;
  assert.equal((await resumed.detail(id)).completionAttempt.state, 'completed'); assert.equal(completions, 1);
});
test('Ably pending list has no date cutoff, paginates and rejects missing or repeated rooms', async () => {
  const a = mockAdapter(), calls = [];
  a.request = async (_, endpoint) => { calls.push(endpoint); if (endpoint.includes('total_count')) return { total_count: '2' }; return endpoint.includes('last_sno=100') ? { is_last: true, last_sno: 99, contact_rooms: [room(99, 2)] } : { is_last: false, last_sno: 100, contact_rooms: [room()] }; };
  const list = await a.list('order_after_delivery'); assert.equal(list.records.length, 1); assert.equal(list.records[0].sourceId, '100');
  assert.ok(calls.every(c => !c.includes('start_date'))); assert.match(calls[0], /status%5B%5D=1&status%5B%5D=2/);
  calls.length = 0; await a.list('goods', '1m');
  assert.ok(calls.every(c => c.includes('start_date') && !c.includes('status%5B%5D=0')));
  a.request = async (_, endpoint) => endpoint.includes('total_count') ? { total_count: '2' } : { is_last: true, contact_rooms: [room()] };
  await assert.rejects(a.list('goods'), e => e.code === 'INQUIRY_CHANGED');
  a.request = async (_, endpoint) => endpoint.includes('total_count') ? { total_count: '2' } : { is_last: false, last_sno: 100, contact_rooms: [room()] };
  await assert.rejects(a.list('goods'), e => e.code === 'INQUIRY_CHANGED');
  await assert.rejects(a.list('wrong')); await assert.rejects(a.list('goods', '1y'));
});
test('Ably details load older messages, keep order context and detect changed participants', async () => {
  const a = mockAdapter(), calls = [];
  a.request = async (_, endpoint) => { calls.push(endpoint); const older = endpoint.includes('first_sno=302'); return { contact_room: room(), is_first: older, first_sno: older ? 300 : 302, contact_messages: older ? [message(300), { ...message(301), type: 3, content: null, order_item: { sno: 500, goods: { name: '테스트 상품' }, delivery_type: 'standard' } }] : [message(302, 'SELLER', '회수 접수했습니다.')] }; };
  const detail = await a.detail(row()); assert.deepEqual(detail.messages.map(m => m.id), ['300', '301', '302']); assert.equal(detail.orderNo, '500'); assert.equal(detail.product, '테스트 상품'); assert.equal(calls.length, 2);
  a.request = async () => ({ contact_room: { ...room(), member: { sno: 21 } }, is_first: true, contact_messages: [] });
  await assert.rejects(a.detail(row()), e => e.code === 'INQUIRY_CHANGED');
});
test('Ably checks current cookie and server account; sends only multipart content after persistence', async () => {
  const token = 'header.' + Buffer.from(JSON.stringify({ seller_id: '40' })).toString('base64url') + '.signature'; let currentToken = token, market = account.storeId, persisted = false; const calls = [];
  const context = { cookies: async () => [{ name: 'ably-seller-admin-jwt-token', value: currentToken }], request: { fetch: async (url, options) => { calls.push({ url, options }); if (options.method === 'POST') { assert.equal(persisted, true); assert.deepEqual(options.multipart, { content: '답변입니다.' }); } return { status: () => 200, json: async () => options.method === 'POST' ? { sno: 900 } : { sno: 40, market: { sno: Number(market), name: account.store } }, dispose: async () => {} }; } } };
  const a = new AblyInquiryAdapter({ getPage: async () => ({ context: () => context }) });
  market = '601'; await assert.rejects(a.reply(row(), '답변입니다.', () => assert.fail()), e => e.code === 'STORE_CHANGED'); assert.ok(calls.every(c => c.options.method === 'GET'));
  market = '600'; const result = await a.reply(row(), '답변입니다.', async () => { persisted = true; }); assert.equal(result.messageId, '900'); assert.match(calls.at(-1).url, /\/seller\/contact_rooms\/100\/send\/$/);
  await assert.rejects(a.reply(row(), '답변입니다.', async () => { currentToken = 'changed'; }), e => e.code === 'ABLY_LOGIN_REQUIRED'); assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
});
test('Ably uncertain sends survive restart and reconcile only an exact new seller message', async t => {
  const directory = await folder(t), current = row(); let sends = 0;
  const a = { list: async () => ({ records: [structuredClone(current)] }), detail: async () => structuredClone(current), reply: async (_, answer, before) => { await before(); sends++; throw new Error('lost response'); } };
  const inbox = new InquiryInbox(directory, a, undefined, { filename: 'ably-inquiries.json' }); await inbox.init(); const id = (await inbox.list('order_after_delivery')).records[0].id;
  await inbox.draft(id, '회수 접수하겠습니다.'); const d = await inbox.detail(id), intent = await inbox.prepare(id, '회수 접수하겠습니다.', d.fingerprint);
  await assert.rejects(inbox.publish(id, intent.token), e => e.code === 'INQUIRY_UNCERTAIN'); assert.equal(sends, 1);
  const resumed = new InquiryInbox(directory, a, undefined, { filename: 'ably-inquiries.json' }); await resumed.init();
  const pending = await resumed.detail(id); await assert.rejects(resumed.prepare(id, '다시 보내기', pending.fingerprint), e => e.code === 'INQUIRY_UNCERTAIN');
  current.messages.push({ id: '999', role: 'seller', text: '회수 접수하겠습니다.', date: '2026-11-18T05:00:00Z' });
  const verified = await resumed.detail(id); assert.equal(verified.attempt.state, 'sent'); assert.equal(verified.draft, ''); assert.equal(sends, 1);
});
test('Ably HTTP routes require CSRF and keep drafts separate from other platforms', async t => {
  const directory = await folder(t), port = 14332, base = `http://127.0.0.1:${port}`, current = row(); let sends = 0;
  const adapter = { summary: async () => ({ items: parseAblyInquiryCounts(Object.fromEntries(ablyInquiryCategories.map(c => [c.id, 0]))) }), list: async () => ({ records: [structuredClone(current)] }), detail: async () => structuredClone(current), reply: async (_, answer, before) => { await before(); sends++; current.messages.push({ id: '999', role: 'seller', text: answer }); return { messageId: '999' }; } };
  const app = await createApp({ directory, port, maintenanceInterval: 0, ablyInquiryAdapter: adapter, coupangInquiryAdapter: { list: async () => ({ records: [structuredClone(current)] }) } });
  t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); }); app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const post = (platform, action, data = {}, token = app.csrf) => fetch(`${base}/api/inquiries/${platform}/${action}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Review-Token': token }, body: JSON.stringify(data) });
  assert.equal((await post('ably', 'sync', {}, 'wrong')).status, 403);
  assert.equal((await (await post('ably', 'sync')).json()).items.length, 7);
  const id = (await (await post('ably', 'list', { category: 'order_after_delivery' })).json()).records[0].id;
  await post('coupang', 'list', { category: 'customer' }); await post('coupang', id + '/draft', { text: '쿠팡 초안' }); await post('ably', id + '/draft', { text: '에이블리 답변' });
  const detail = await (await post('ably', id + '/detail')).json(); const intent = await (await post('ably', id + '/prepare', { text: '에이블리 답변', fingerprint: detail.fingerprint })).json(); assert.equal(sends, 0);
  assert.equal((await post('ably', id + '/publish', { token: intent.token })).status, 200); assert.equal(sends, 1);
  assert.match(await readFile(path.join(directory, 'coupang-inquiries.json'), 'utf8'), /쿠팡 초안/);
  assert.equal((await post('ably', id + '/publish', { token: intent.token })).status, 409);
});

test('Ably completion HTTP endpoints enforce CSRF, separate reply tokens and recheck account changes', async t => {
  const directory = await folder(t), port = 14333, base = `http://127.0.0.1:${port}`, current = row(); let calls = 0, switched = false;
  const adapter = { list: async () => ({ records: [structuredClone(current)] }), detail: async () => { if (switched) return { ...structuredClone(current), storeId: '601' }; return structuredClone(current); }, complete: async (_, before) => { await before(); calls++; current.status = 'answered'; current.canComplete = false; current.meta.roomStatus = 3; } };
  const app = await createApp({ directory, port, maintenanceInterval: 0, ablyInquiryAdapter: adapter }); t.after(async () => { app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); }); app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const post = (action, data = {}, token = app.csrf) => fetch(base + '/api/inquiries/ably/' + action, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Review-Token': token }, body: JSON.stringify(data) });
  const id = (await (await post('list', { category: 'order_after_delivery' })).json()).records[0].id;
  assert.equal((await post(id + '/complete', {}, 'wrong')).status, 403); assert.equal((await post(id + '/complete')).status, 409);
  const d = await (await post(id + '/detail')).json(); const reply = await (await post(id + '/prepare', { text: '답변', fingerprint: d.fingerprint })).json(); assert.equal((await post(id + '/complete', { token: reply.token })).status, 409);
  const pending = await (await post(id + '/complete-prepare', { fingerprint: d.fingerprint })).json(); assert.equal(calls, 0); switched = true;
  assert.equal((await post(id + '/complete', { token: pending.token })).status, 409); assert.equal(calls, 0); switched = false;
  const approved = await (await post(id + '/complete-prepare', { fingerprint: d.fingerprint })).json(); const done = await (await post(id + '/complete', { token: approved.token })).json(); assert.equal(done.completed, true); assert.equal(calls, 1);
  assert.equal((await post(id + '/complete', { token: approved.token })).status, 409);
});
