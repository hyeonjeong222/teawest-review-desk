import { AppError } from './core.js';
import { inquiryCategories } from './naver-inquiries.js';

const seller = 'https://sell.smartstore.naver.com';
const talk = 'https://talk.sell.smartstore.naver.com';
const layout = () => new AppError('네이버 문의 응답을 확인하지 못했습니다. 다시 조회해 주세요.', 502, 'INQUIRY_LAYOUT');
const number = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0 || value === null || value === '') throw layout(); return n; };
const id = value => { const text = String(value ?? ''); if (!/^[a-zA-Z0-9_-]{1,100}$/.test(text)) throw layout(); return text; };
export function plainText(value) {
  return String(value ?? '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27);/gi, match => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&#39;': "'", '&#x27;': "'" }[match.toLowerCase()]))
    .replace(/&#(\d{1,7});|&#x([a-f\d]{1,6});/gi, (match, dec, hex) => { const code = parseInt(dec || hex, dec ? 10 : 16); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; }).trim();
}
export function parseSellerJSON(text) {
  // This legacy response emits a single-quoted dash in one fixed field. Never eval it.
  try { return JSON.parse(text.replace(/("answerSatisfactionYn"\s*:\s*)'-'/g, '$1"-"')); } catch { throw layout(); }
}
export function inquiryRange(period = '3m', now = new Date()) {
  if (!['1m', '3m'].includes(period)) throw new AppError('문의 조회 기간은 1개월 또는 3개월입니다.');
  const today = new Date(now.getTime() + 9 * 3600000), from = new Date(today);
  from.setUTCDate(from.getUTCDate() - (period === '1m' ? 30 : 90));
  return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10), period };
}
const message = (sourceId, role, text, date = '') => ({ id: String(sourceId), role, text: plainText(text), date: String(date || '') });
export function normalizeProduct(row) {
  if (!row || typeof row.commentContent !== 'string' || typeof row.sellerAnswer !== 'boolean') throw layout();
  return { sourceId: id(row.id), category: 'product', title: plainText(row.commentContent).slice(0, 100), content: plainText(row.commentContent), product: plainText(row.productName || row.contentsName), author: plainText(row.maskedWriterId), date: row.regDate || '', status: row.sellerAnswer ? 'answered' : 'pending', canReply: !row.sellerAnswer && row.contentsStatusType === 'NORMAL', secret: row.secret === true, messages: [], meta: { contentsName: row.contentsName, contentsObjectId: row.contentsObjectId, commentType: row.commentType, secret: row.secret === true, storeType: row.storeType, productNo: row.productNo } };
}
export function normalizeCustomer(row) {
  if (!row || typeof row.title !== 'string' || !['답변완료', '미답변', '답변대기', 'Y', 'N'].includes(row.answerYn)) throw layout();
  const answered = ['답변완료', 'Y'].includes(row.answerYn);
  return { sourceId: id(row.id), category: 'customer', title: plainText(row.title), content: '', product: plainText(row.productName), option: plainText(row.productOption), author: plainText(row.inquiryMemberName), date: row.regDate || '', status: answered ? 'answered' : 'pending', canReply: !answered, orderNo: String(row.orderNo || ''), type: plainText(row.inquiryCategory), messages: [], meta: {} };
}
export function normalizeCenter(row) {
  if (!row || !['OPEN', 'ANSWERED', 'CLOSED'].includes(row.status)) throw layout();
  return { sourceId: id(row.ticketNo), category: 'center', title: plainText(row.title), content: '', product: String(row.channelProductNo || ''), author: '네이버 고객센터', date: row.openedAt || row.regDate || '', status: { OPEN: 'pending', ANSWERED: 'answered', CLOSED: 'closed' }[row.status], canReply: row.status !== 'CLOSED', orderNo: String(row.productOrderNo || ''), messages: [], meta: {} };
}
export function normalizeTalk(row, account) {
  if (!row || !row.userId || typeof row.counselStatus !== 'string') throw layout();
  const blocked = row.partnerBlock || row.partnerHoldBack || row.spam || row.partnerEnd;
  return { sourceId: id(row.userId), category: 'talktalk', title: plainText(row.nicknameMemo || row.nickname || row.name || '톡톡 대화'), content: plainText(row.lastMessage || row.message || ''), product: '', author: plainText(row.nickname || row.name || '고객'), date: row.date || '', status: row.counselStatus === 'WAIT' ? 'pending' : row.counselStatus === 'END' ? 'closed' : 'answered', canReply: !blocked, messages: [], meta: { account: id(account) } };
}

export class NaverInquiryAdapter {
  constructor(connector) { this.connector = connector; }
  async identity(expected) {
    const current = await this.connector.status(true);
    if (current.networkError) throw new AppError('네이버 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.', 502, 'INQUIRY_FETCH');
    if (!current.connected || !current.store) throw new AppError('네이버 연결 창에서 로그인과 추가 인증을 완료해 주세요.', 409, 'LOGIN_REQUIRED');
    if (expected && expected !== current.store) throw new AppError('네이버 스토어가 변경되었습니다. 문의 목록을 다시 조회해 주세요.', 409, 'STORE_CHANGED');
    return current.store;
  }
  async request(url, options = {}) {
    const target = new URL(url);
    if (![seller, talk].includes(target.origin)) throw layout();
    const page = await this.connector.getPage(); let response;
    try {
      response = await page.request.fetch(url, { timeout: 25000, maxRedirects: 0, headers: { Accept: 'application/json' }, ...options });
      if ([301, 302, 303, 307, 308, 401, 403].includes(response.status())) throw new AppError('네이버 로그인을 다시 확인해 주세요.', 409, 'LOGIN_REQUIRED');
      if (!response.ok()) throw new AppError('네이버 문의 요청에 실패했습니다. 다시 조회해 주세요.', 502, 'INQUIRY_FETCH');
      const text = await response.text();
      if (!text.trim() && response.status() === 204) return {};
      const result = parseSellerJSON(text);
      if (result?.bSuccess === false || result?.sErrorCode || result?.error) throw new AppError('네이버에서 문의 요청을 처리하지 못했습니다. 문의 상태를 다시 확인해 주세요.', 409, 'INQUIRY_REJECTED');
      return result;
    } finally { await response?.dispose?.(); }
  }
  async talkAccount() {
    const data = await this.request(`${seller}/api/v1/sellers/dashboards/inquiries`);
    const account = id(data.talkAccountId);
    return account;
  }
  async list(category, period) {
    if (!inquiryCategories.some(x => x.id === category)) throw new AppError('지원하지 않는 문의 항목입니다.');
    const store = await this.identity(), range = inquiryRange(period), rows = [], seen = new Set();
    let total = null, cursor, account;
    if (category === 'talktalk') account = await this.talkAccount();
    for (let page = 0; page < 100; page++) {
      let data, items, done;
      if (category === 'product') {
        data = await this.request(`${seller}/api/v3/contents/comments/pages`, { params: { commentType: '', endDate: range.to + 'T23:59:59.999+09:00', keyword: '', page, range: 5, searchKeywordType: 'PRODUCT_NAME', sellerAnswer: '', size: 50, startDate: range.from + 'T00:00:00.000+09:00', totalCount: 0 } });
        if (!Array.isArray(data.contents)) throw layout();
        total ??= number(data.totalElements); if (total !== number(data.totalElements)) throw layout();
        items = data.contents.map(normalizeProduct); done = data.last === true;
      } else if (category === 'customer') {
        data = await this.request(`${seller}/u/customerInquiry/list`, { method: 'POST', form: { fromDate: range.from, toDate: range.to, searchStartYmdt: range.from + ' 00:00:00', searchEndYmdt: range.to + ' 23:59:59', satisfaction: '', treatmentStatus: '', inquiryType: '', searchType: '', queryText: '', orderBy: '', orderDir: '', 'paging.current': page + 1 } });
        if (data.bSuccess !== true || !Array.isArray(data.htReturnValue)) throw layout();
        total ??= number(data.totalCount); if (total !== number(data.totalCount)) throw layout();
        items = data.htReturnValue.map(normalizeCustomer); done = (page + 1) * Math.max(1, number(data.rowsPerPage)) >= total;
      } else if (category === 'center') {
        data = await this.request(`${seller}/api/v1/sellers/cs-tickets`, { params: { page, size: 50, dateField: 'LAST_REPLIED_AT', dateFrom: range.from, dateTo: range.to } });
        if (!Array.isArray(data.items)) throw layout();
        total ??= number(data.totalCount); if (total !== number(data.totalCount)) throw layout();
        items = data.items.map(normalizeCenter); done = (page + 1) * 50 >= total;
      } else {
        data = await this.request(`${talk}/chatapi/ct/partner/${account}/list`, { method: 'POST', multipart: { fromDate: range.from.replaceAll('-', ''), toDate: range.to.replaceAll('-', ''), order: 'lstDesc', filter: 'all', ...(cursor ? { min: cursor } : {}) } });
        data = data.htReturnValue;
        if (!Array.isArray(data?.chatList) || typeof data.hasNextPage !== 'boolean') throw layout();
        items = data.chatList.map(row => normalizeTalk(row, account)); done = !data.hasNextPage;
        const next = data.chatList.at(-1)?.date;
        if (!done && (!next || String(next) === cursor)) throw layout();
        cursor = String(next || '');
      }
      for (const item of items) { if (seen.has(item.sourceId)) throw layout(); seen.add(item.sourceId); rows.push({ ...item, store }); }
      if (done) {
        if (total !== null && rows.length !== total) throw layout();
        await this.identity(store);
        return { category, store, range, records: rows, checkedAt: new Date().toISOString() };
      }
      if (!items.length) throw layout();
    }
    throw new AppError('문의 조회 범위가 큽니다. 기간을 줄여 다시 조회해 주세요.', 409, 'INQUIRY_LIMIT');
  }
  async detail(record) {
    await this.identity(record.store);
    const sourceId = id(record.sourceId), result = { ...record };
    if (record.category === 'product') {
      // The seller client exposes paged roots and replies, but no GET-by-id root.
      const fresh = await this.list('product', '3m');
      const row = fresh.records.find(item => item.sourceId === sourceId);
      if (!row || fresh.store !== record.store) throw new AppError('조회 기간에서 문의를 찾지 못했습니다. 목록을 다시 조회해 주세요.', 409, 'INQUIRY_CHANGED');
      Object.assign(result, row);
      const replies = await this.request(`${seller}/api/v3/contents/comments/${sourceId}/replies`);
      if (!Array.isArray(replies)) throw layout();
      result.messages = [message(sourceId, 'customer', result.content, result.date), ...replies.map(r => message(id(r.id), ['BUSINESS', 'NAVER', 'OPENAPI', 'PARTNER'].includes(r.regMemberType) ? 'seller' : 'customer', r.commentContent, r.regDate))];
    } else if (record.category === 'customer') {
      const data = await this.request(`${seller}/u/customerInquiry/inquiryComment/${sourceId}`, { method: 'POST' });
      const row = data.htReturnValue;
      if (!row || String(row.id) !== sourceId || typeof row.inquiryContent !== 'string') throw layout();
      result.content = plainText(row.inquiryContent); result.title = plainText(row.title); result.product = plainText(row.productName); result.option = plainText(row.productOption); result.author = plainText(row.memberName); result.orderNo = String(row.orderNo || '');
      result.status = row.commentId && row.commentContent ? 'answered' : 'pending'; result.canReply = result.status === 'pending';
      result.meta = { alarmType: String(row.alarmType || ''), commentId: String(row.commentId || '') };
      result.messages = [message(sourceId, 'customer', row.inquiryContent, row.modifyDate), ...(row.commentId && row.commentContent ? [message(row.commentId, 'seller', row.commentContent, row.treatmentDate)] : [])];
    } else if (record.category === 'center') {
      const row = await this.request(`${seller}/api/v1/sellers/cs-tickets/${sourceId}`);
      if (String(row.ticketNo) !== sourceId || !Array.isArray(row.messages)) throw layout();
      Object.assign(result, normalizeCenter(row));
      result.messages = row.messages.map(m => message(id(m.id), m.messageType === 'ANSWER' ? 'seller' : 'customer', m.body, m.writtenAt));
      result.content = result.messages.find(m => m.role === 'customer')?.text || '';
      if (row.messages.some(m => m.attachments?.length)) result.historyNote = '첨부파일이 있는 문의입니다. 파일은 판매자센터에서 확인해 주세요.';
    } else {
      const account = await this.talkAccount();
      if (account !== record.meta.account) throw new AppError('톡톡 계정이 변경되었습니다. 문의 목록을 다시 조회해 주세요.', 409, 'STORE_CHANGED');
      const raw = await this.request(`${talk}/chatapi/ct/partner/${account}/chat/${sourceId}?detail=true`, { method: 'POST' });
      const config = raw.htReturnValue;
      if (!config?.chat || (config.chat.userId && String(config.chat.userId) !== sourceId)) throw layout();
      const endpoint = `${talk}/chatapi/ct/partner/${account}/chat/${sourceId}`;
      const response = await this.request(endpoint + '/read', { method: 'POST', multipart: { min: '', max: '', updateRead: 'false' } });
      const data = response.htReturnValue;
      if (!Array.isArray(data?.messageList)) throw layout();
      result.messages = data.messageList.map(m => message(id(m.id), m.sender === 'partner' ? 'seller' : m.sender === 'user' ? 'customer' : 'system', m.textContent?.text || m.imageContent?.title || (m.contentType ? `[${m.contentType} 메시지]` : ''), m.date || m.regDate));
      result.messages.sort((a, b) => Number(a.id) - Number(b.id));
      result.content = result.messages.filter(m => m.role === 'customer').at(-1)?.text || '';
      result.canReply = !config.block && !config.chat.partnerBlock && !config.chat.partnerHoldBack && !config.chat.spam && config.chat.userStatus !== 'LEAVE';
      result.status = result.canReply ? result.messages.at(-1)?.role === 'customer' ? 'pending' : 'answered' : 'closed';
      result.historyNote = '최근 대화를 표시합니다. 이미지·파일 등은 판매자센터에서 확인해 주세요.';
      // Per-session sender data stays in memory and is re-read at send time.
      result.meta = { account };
    }
    await this.identity(record.store);
    return { ...result, store: record.store, detailed: true };
  }
  async reply(record, text, beforeSend) {
    await this.identity(record.store);
    const sourceId = id(record.sourceId);
    if (record.category === 'product') {
      const body = { ...record.meta, commentContent: text, parentCommentSeq: Number(sourceId), parentCommentId: Number(sourceId), level: 1 };
      if (!body.commentType || !body.contentsObjectId || !body.storeType) throw layout();
      await beforeSend();
      await this.request(`${seller}/api/v3/contents/comments`, { method: 'POST', data: body });
    } else if (record.category === 'customer') {
      if (record.meta.commentId) throw new AppError('이미 답변한 문의입니다.', 409, 'ALREADY_REPLIED');
      await beforeSend();
      await this.request(`${seller}/u/customerInquiry/commentAction`, { method: 'POST', form: { 'id.inquiryNo': sourceId, 'id.inquiryCommentNo': '', alarmType: record.meta.alarmType, inquiryAnswerTempleteType: 'NONE_SELECTED', inquiryAnswerTempleteNo: 'NONE_SELECTED', content: text } });
    } else if (record.category === 'center') {
      await beforeSend();
      await this.request(`${seller}/api/v1/sellers/cs-tickets/${sourceId}/messages/answer`, { method: 'POST', data: { body: text } });
    } else {
      const account = await this.talkAccount();
      if (account !== record.meta.account) throw new AppError('톡톡 계정이 변경되었습니다.', 409, 'STORE_CHANGED');
      await beforeSend();
      await this.request(`${talk}/chatapi/ct/partner/${account}/chat/${sourceId}/send`, { method: 'POST', multipart: { jsonMessageList: JSON.stringify([{ textContent: { text } }]) } });
    }
  }
}
