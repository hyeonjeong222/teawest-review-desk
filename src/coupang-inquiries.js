import { AppError } from './core.js';
import { coupangDateWindows } from './coupang.js';

const origin = 'https://wing.coupang.com';
const layout = () => new AppError('쿠팡 문의 형식을 확인하지 못했습니다. 기존 목록을 유지합니다.', 502, 'COUPANG_INQUIRY_LAYOUT');
const sourceId = value => { const n = String(value ?? ''); if (!/^\d{1,16}$/.test(n) || !Number.isSafeInteger(Number(n))) throw layout(); return n; };
const count = value => { if (!Number.isSafeInteger(value) || value < 0) throw layout(); return value; };
const text = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const isoDate = value => { if (!value || !Number.isFinite(new Date(value).getTime())) throw layout(); return new Date(value).toISOString(); };
export const coupangInquiryCategories = [
  { id: 'center', label: '고객센터 문의', route: '/tenants/cs/csinquiry', field: 'csUnansweredInquiry' },
  { id: 'customer', label: '고객문의', route: '/tenants/cs/product/inquiries', field: 'productUnansweredInquiry' },
];
export const coupangConfirmationText = '[쿠팡 시스템] 판매자님이 확인하신 CS문의입니다.';
export function coupangInquiryRange(period = '1m', now = new Date()) {
  if (!['1m', '3m'].includes(period)) throw new AppError('문의 조회 기간은 30일 또는 3개월입니다.');
  const to = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10), from = new Date(to + 'T00:00:00Z');
  from.setUTCDate(from.getUTCDate() - (period === '1m' ? 29 : 89));
  return { from: from.toISOString().slice(0, 10), to, period };
}
export function parseCoupangInquiryCounts(data) {
  if (data?.targetDay !== 30) throw layout();
  return coupangInquiryCategories.map(({ id, label, field }) => ({ id, label, count: count(data[field]?.count) }));
}
export function parseCoupangSeller(html) {
  const script = String(html).match(/window\.__GLOBAL_DATA__\s*=\s*\{([\s\S]*?)\};/)?.[1];
  const vendorId = script?.match(/\bvendorId\s*:\s*['"]([A-Za-z0-9_-]{1,60})['"]/)?.[1];
  const name = script?.match(/\bvendorName\s*:\s*(['"])(.*?)\1/)?.[2];
  if (!vendorId || !name || name.includes('\\')) throw layout();
  return { store: name, storeId: vendorId };
}
export function normalizeCoupangCustomer(row) {
  if (typeof row?.content !== 'string' || !Array.isArray(row.answerList)) throw layout();
  const id = sourceId(row.productInquiryId), answered = row.answerList.length > 0;
  return { sourceId: id, platform: 'coupang', category: 'customer', title: text(row.content).slice(0, 100), content: text(row.content), product: text(row.itemName), author: text(row.memberBasicInfo?.memberName || '고객'), date: isoDate(row.inquiryAt), orderNo: (row.orderInfoDtos || []).map(r => sourceId(r.orderId)).join(', '), status: answered ? 'answered' : 'pending', canReply: !answered, replyLimit: 2000, detailed: true,
    messages: [{ id: 'question-' + id, role: 'customer', text: text(row.content), date: isoDate(row.inquiryAt) }, ...row.answerList.map(r => { if (String(r.inquiryId) !== id || typeof r.content !== 'string') throw layout(); return { id: sourceId(r.inquiryCommentId), role: 'seller', text: text(r.content), date: isoDate(r.inquiryCommentAt) }; })],
    historyNote: row.thumbnailList?.length ? '이미지가 첨부된 문의입니다. 첨부파일은 쿠팡윙에서 확인해 주세요.' : '', meta: { productId: sourceId(row.productId), vendorItemId: sourceId(row.vendorItemId) } };
}
export function normalizeCoupangCenter(row, detailed = false) {
  const id = sourceId(row?.inquiry_id), status = String(row.process_status || '').toUpperCase();
  if (!['UNANSWERED', 'UNIDENTIFIED', 'ANSWERED', 'ANSWER_COMPLETED'].includes(status)) throw layout();
  const mode = String(row.comment_type || '').toUpperCase();
  if (detailed && !['NEED_REPLY', 'CONFIRM', 'NO_NEED_COMMENT'].includes(mode)) throw layout();
  const comments = row.comments || []; if (!Array.isArray(comments)) throw layout();
  const messages = comments.map((m, i) => { if (typeof m.body !== 'string') throw layout(); return { id: sourceId(m.id), role: i === 0 ? 'customer' : 'system', label: text(m.author_name || '쿠팡 고객센터'), text: text(m.body), date: isoDate(m.created_at) }; });
  const content = messages[0]?.text || text(row.content);
  if (detailed && !messages.length && content) messages.push({ id: 'question-' + id, role: 'customer', text: content, date: isoDate(row.transferred_at) });
  const completed = ['ANSWERED', 'ANSWER_COMPLETED'].includes(status);
  return { sourceId: id, platform: 'coupang', category: 'center', title: text(row.inquiry_type || content || '고객센터 문의'), content, product: text(row.order?.representative_item_name), author: text(row.order?.customer_name || row.requester_name || '쿠팡 고객센터'), orderNo: row.order?.order_id ? sourceId(row.order.order_id) : '', date: isoDate(row.transferred_at), status: completed ? 'answered' : 'pending', statusLabel: status === 'UNIDENTIFIED' ? '확인 대기' : completed ? '처리 완료' : '답변 대기', canReply: detailed && !completed && ['NEED_REPLY', 'CONFIRM'].includes(mode), replyMode: mode === 'CONFIRM' ? 'confirm' : 'reply', confirmationText: mode === 'CONFIRM' ? coupangConfirmationText : undefined, replyLimit: 2000, detailed, messages,
    historyNote: row.attachments?.length || comments.some(m => m.attachments?.length) ? '첨부파일이 있는 문의입니다. 파일은 쿠팡윙에서 확인해 주세요.' : '', meta: { commentType: mode } };
}

export class CoupangInquiryAdapter {
  constructor(connector) { this.connector = connector; }
  async identity(expected) {
    const status = await this.connector.status(true);
    if (status.networkError) throw new AppError('쿠팡 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.', 502, 'COUPANG_INQUIRY_FETCH');
    if (!status.connected) throw new AppError('쿠팡 연결 창에서 로그인과 추가 인증을 완료해 주세요.', 409, 'COUPANG_LOGIN_REQUIRED');
    const page = await this.connector.getPage();
    // Re-read the server account. A browser tab can retain the previous seller's globals.
    const response = await page.context().request.get(origin + '/tenants/cs/product/inquiries', { maxRedirects: 0, timeout: 10000 });
    let identity;
    try {
      if ([301, 302, 303, 307, 308, 401, 403].includes(response.status())) throw new AppError('쿠팡 연결 창에서 다시 로그인해 주세요.', 409, 'COUPANG_LOGIN_REQUIRED');
      if (response.status() !== 200) throw new AppError('쿠팡 판매자 계정을 확인하지 못했습니다.', 502, 'COUPANG_INQUIRY_FETCH');
      identity = parseCoupangSeller(await response.text());
    } finally { await response.dispose?.(); }
    if (expected && (expected.store !== identity.store || expected.storeId !== identity.storeId)) throw new AppError('쿠팡 판매자 계정이 변경되었습니다. 문의를 다시 조회해 주세요.', 409, 'STORE_CHANGED');
    return identity;
  }
  async request(endpoint, body) {
    if (!endpoint.startsWith('/tenants/cs/') || endpoint.includes('..')) throw layout();
    const page = await this.connector.getPage();
    const response = await page.evaluate(async ({ endpoint, body }) => {
      if (location.origin !== 'https://wing.coupang.com') return { status: 401 };
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
      try { const r = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json().catch(() => null) }; }
      catch { return { status: 0 }; } finally { clearTimeout(timer); }
    }, { endpoint, body });
    if ([401, 403].includes(response.status)) throw new AppError('쿠팡 로그인이 만료되었거나 권한이 없습니다. 연결 창에서 확인해 주세요.', 409, 'COUPANG_LOGIN_REQUIRED');
    if (response.status !== 200 || !response.data) throw new AppError('쿠팡 문의 요청에 실패했습니다. 내용을 다시 확인해 주세요.', 502, 'COUPANG_INQUIRY_FETCH');
    if (response.data.success === false || (response.data.code && response.data.code !== 'OK')) throw new AppError('쿠팡에서 요청을 처리하지 못했습니다. 문의 상태를 새로고침해 주세요.', 409, 'COUPANG_INQUIRY_REJECTED');
    return response.data;
  }
  async summary() {
    const identity = await this.identity(), data = await this.request('/tenants/cs/card/content/unanswered-inquiry');
    const items = parseCoupangInquiryCounts(data); await this.identity(identity);
    return { platform: 'coupang', store: identity.store, checkedAt: new Date().toISOString(), targetDay: 30, items };
  }
  async list(category, period = '1m', fixedRange) {
    if (!coupangInquiryCategories.some(x => x.id === category)) throw new AppError('지원하지 않는 쿠팡 문의 항목입니다.');
    const identity = await this.identity(), range = fixedRange || coupangInquiryRange(period), records = [], seen = new Set(); let requests = 0;
    for (const window of coupangDateWindows(range.from, range.to)) {
      let expected, pages, received = 0;
      for (let index = 0; ; index++) {
        if (++requests > 150) throw new AppError('문의 조회 범위가 큽니다. 기간을 줄여 주세요.', 422, 'INQUIRY_LIMIT');
        const from = window.from.replaceAll('-', '.'), to = window.to.replaceAll('-', '.');
        const result = await this.request(category === 'customer' ? '/tenants/cs/product/inquiries/list' : '/tenants/cs/csinquiry/list', category === 'customer'
          ? { startTime: from, endTime: to, inquiryState: 'ALL', page: index, countPerPage: 50, sortField: 'registerDate', desc: true, source: 'search' }
          : { staredAt: from, endedAt: to, processStatusList: ['all'], pageNum: index + 1, pageSize: 50 });
        const data = result.data, page = data?.pagination;
        if (result.success !== true || !Array.isArray(data?.content) || !page || page.currentPage !== index + (category === 'center' ? 1 : 0)) throw layout();
        const total = count(page.totalElements), totalPages = count(page.totalPages);
        if (total && !totalPages) throw layout();
        expected ??= total; pages ??= totalPages;
        if (expected !== total || pages !== totalPages) throw new AppError('조회 중 문의 목록이 변경되었습니다. 다시 조회해 주세요.', 409, 'INQUIRY_CHANGED');
        for (const row of data.content) {
          const record = category === 'customer' ? normalizeCoupangCustomer(row) : normalizeCoupangCenter(row);
          if (seen.has(record.sourceId)) throw layout(); seen.add(record.sourceId); received++;
          records.push({ ...record, ...identity });
        }
        if (index + 1 >= pages) break;
        if (!data.content.length) throw layout();
      }
      if (received !== expected) throw layout();
    }
    await this.identity(identity); records.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    return { platform: 'coupang', category, store: identity.store, range, checkedAt: new Date().toISOString(), records };
  }
  async detail(record) {
    await this.identity(record); const id = sourceId(record.sourceId); let fresh;
    if (record.category === 'customer') {
      const day = new Date(Date.parse(record.date) + 9 * 3600000).toISOString().slice(0, 10);
      const list = await this.list('customer', '1m', { from: day, to: day, period: '1m' });
      fresh = list.records.find(r => r.sourceId === id);
      if (!fresh || fresh.meta.productId !== record.meta.productId || fresh.meta.vendorItemId !== record.meta.vendorItemId) throw new AppError('해당 문의를 찾지 못했거나 상품이 변경되었습니다.', 409, 'INQUIRY_CHANGED');
    } else if (record.category === 'center') {
      const result = await this.request(`/tenants/cs/csinquiry/${id}/detail`);
      if (String(result.data?.inquiry_id) !== id) throw layout();
      fresh = { ...normalizeCoupangCenter(result.data, true), store: record.store, storeId: record.storeId };
    } else throw layout();
    await this.identity(record); return fresh;
  }
  async reply(record, answer, beforeSend) {
    await this.identity(record); const id = sourceId(record.sourceId);
    if (!record.detailed || !record.canReply || !answer.trim() || answer.length > 2000) throw new AppError('답변할 수 없는 문의이거나 답변 길이가 올바르지 않습니다.', 409);
    if (record.replyMode === 'confirm' && answer !== coupangConfirmationText) throw new AppError('확인완료 처리 내용이 올바르지 않습니다.', 409);
    if (!['customer', 'center'].includes(record.category)) throw layout();
    await beforeSend();
    const result = await this.request(record.category === 'customer' ? '/tenants/cs/product/inquiries/comment' : '/tenants/cs/csinquiry/comment', record.category === 'customer' ? { inquiryId: Number(id), content: answer } : { ticket_id: Number(id), ticket_comment: { body: answer, tokens: [] } });
    const messageId = record.category === 'customer' ? result.data?.commentId : result.data?.comment?.id || result.data?.id;
    return messageId ? { messageId: sourceId(messageId) } : {};
  }
  async open(category) {
    const item = coupangInquiryCategories.find(x => x.id === category); if (!item) throw new AppError('지원하지 않는 문의 항목입니다.');
    await this.identity(); const browser = await this.connector.connect(), context = browser.contexts()[0], url = origin + item.route;
    let page = context.pages().find(p => p.url() === url);
    if (!page) { page = await context.newPage(); try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch (e) { await page.close().catch(() => {}); throw e; } }
    await page.bringToFront(); return { opened: true, category };
  }
}
