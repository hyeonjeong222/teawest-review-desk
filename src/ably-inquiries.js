import { AppError } from './core.js';
import { coupangInquiryRange } from './coupang-inquiries.js';

const origin = 'https://api.a-bly.com';
const sellerOrigin = 'https://my.a-bly.com';
const cookieName = 'ably-seller-admin-jwt-token';
const layout = () => new AppError('에이블리 문의 형식을 확인하지 못했습니다. 기존 목록을 유지합니다.', 502, 'ABLY_INQUIRY_LAYOUT');
const login = () => new AppError('에이블리 연결 창에서 로그인과 추가 인증을 완료해 주세요.', 409, 'ABLY_LOGIN_REQUIRED');
const changed = () => new AppError('조회 중 에이블리 문의 또는 계정이 변경되었습니다. 다시 조회해 주세요.', 409, 'INQUIRY_CHANGED');
const id = value => { const s = String(value ?? ''); if (!/^[1-9]\d{0,15}$/.test(s) || !Number.isSafeInteger(Number(s))) throw layout(); return s; };
const count = value => { if (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw layout(); return Number(value); };
const text = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const date = value => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw layout(); const d = new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : value + '+09:00'); if (!Number.isFinite(d.getTime())) throw layout(); return d.toISOString(); };
export const ablyInquiryCategories = [
  { id: 'goods', label: '상품 문의', codes: [2, 3, 4, 5, 9, 101, 102, 103, 104, 120, 121, 122, 123] },
  { id: 'order_before_delivery', label: '배송 전 변경 / 취소문의', codes: [12, 14, 107, 109, 126, 128] },
  { id: 'order_after_delivery', label: '교환 / 반품 문의', codes: [15, 16, 110, 111, 129, 130] },
  { id: 'order_etc', label: '배송 / 기타 / 결제 문의', codes: [11, 13, 19, 106, 108, 125, 127] },
  { id: 'etc', label: '기타 문의', codes: [] },
  { id: 'place', label: '플레이스 문의', codes: [153] },
  { id: 'affiliate_sponsorship', label: '협찬 문의', codes: [172] },
];
const categoryOf = room => { const code = Number(id(room.child_category)); return ablyInquiryCategories.find(c => c.codes.includes(code))?.id || 'etc'; };
const validCategory = category => { if (!ablyInquiryCategories.some(c => c.id === category)) throw new AppError('지원하지 않는 에이블리 문의 항목입니다.'); };
export function parseAblyInquiryCounts(data) {
  return ablyInquiryCategories.map(({ id, label }) => ({ id, label, count: count(data?.[id]) }));
}
// Cards contain HTML and action payloads. Keep display text only; never execute their actions.
export function ablyCardText(card) {
  const plain = value => text(value).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, code) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (code[0] !== '#') return named[code.toLowerCase()];
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : match;
    }).replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (Array.isArray(card?.sections) ? card.sections : []).filter(s => ['HTML', 'BUTTON'].includes(s.type) && typeof s.contents?.text === 'string')
    .map(s => (s.type === 'BUTTON' ? '선택 항목: ' : '') + plain(s.contents.text)).filter(Boolean).join('\n\n');
}
const imageUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'd3ha2047wt6x28.cloudfront.net' && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };
export function normalizeAblyMessage(raw) {
  const messageId = id(raw?.sno);
  if (!['USER', 'SELLER', 'ADMIN'].includes(raw.member_type) || typeof raw.is_written_by_system !== 'boolean') throw layout();
  let content = text(raw.content);
  if (raw.deleted_at) content = '삭제된 메시지입니다.';
  else if (raw.type === 2) content = content || '첨부 이미지';
  else if (raw.type === 3) content = [raw.goods?.name || raw.order_item?.goods?.name || '상품 · 주문 정보', raw.order_item?.sno ? '상품주문번호 ' + id(raw.order_item.sno) : ''].filter(Boolean).join('\n');
  else if (raw.type === 5) content = content || ablyCardText(raw.card) || '내용을 표시할 수 없는 안내입니다. 판매자센터에서 확인해 주세요.';
  else if (raw.type !== 1 || typeof raw.content !== 'string') throw layout();
  const image = !raw.deleted_at && raw.type === 2 ? imageUrl(raw.transformed_image_url) || imageUrl(raw.image_url) : undefined;
  return { id: messageId, role: raw.member_type === 'USER' ? 'customer' : raw.member_type === 'SELLER' && !raw.is_written_by_system && !raw.deleted_at ? 'seller' : 'system', text: content, date: date(raw.created_at),
    ...(raw.type === 5 && !raw.deleted_at ? { label: '자동 안내' } : {}), ...(image ? { image } : {}) };
}
export function normalizeAblyRoom(raw, account, { sourceId = raw?.sno, messages = [], detailed = false } = {}) {
  if (!raw || ![0, 1, 2, 3, 4, 5].includes(raw.status) || typeof raw.is_ably !== 'boolean') throw layout();
  if (id(raw.market?.sno) !== account.storeId || raw.market?.name !== account.store) throw new AppError('에이블리 판매자 계정이 변경되었습니다. 문의를 다시 조회해 주세요.', 409, 'STORE_CHANGED');
  const category = categoryOf(raw), customerId = id(raw.member?.sno);
  const ordered = [...messages].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || Number(a.id) - Number(b.id));
  const latest = raw.latest_message?.content || ordered.filter(m => m.role === 'customer').at(-1)?.text || '';
  const closed = [0, 4, 5].includes(raw.status), deliveryType = raw.order_item?.delivery_type;
  return { platform: 'ably', sourceId: id(sourceId), ...account, category,
    title: [raw.parent_category_display, raw.child_category_display].filter(Boolean).join(' / ') || ablyInquiryCategories.find(c => c.id === category).label,
    content: text(latest), author: text(raw.member?.name || '고객'), product: text(raw.goods?.name || raw.order_item?.goods?.name), orderNo: raw.order_item?.sno ? id(raw.order_item.sno) : '',
    date: date(raw.updated_latest_message_at || raw.created_at), status: closed ? 'closed' : raw.status === 3 ? 'answered' : 'pending',
    statusLabel: ['대기', '진행 중', '보류', '처리 완료', '종료', '강제 종료'][raw.status], canReply: detailed && !closed && !raw.is_ably && deliveryType !== 'third_pl',
    canComplete: detailed && [1, 2].includes(raw.status) && !raw.is_ably && deliveryType !== 'third_pl',
    replyLimit: 3000, detailed, messages: ordered,
    historyNote: '답변을 마친 뒤 문의 완료 처리를 눌러 주세요. 자동 안내의 선택 항목은 대화 이력으로 표시됩니다.',
    meta: { customerId, childCategory: raw.child_category, roomStatus: raw.status, isAbly: raw.is_ably, deliveryType: deliveryType || '' } };
}

export class AblyInquiryAdapter {
  constructor(connector) { this.connector = connector; }
  async token(page) { return (await page.context().cookies(sellerOrigin)).find(c => c.name === cookieName)?.value; }
  async identity(expected) {
    const page = await this.connector.getPage(), token = await this.token(page);
    if (!token) throw login();
    let sellerId; try { sellerId = id(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).seller_id); } catch { throw login(); }
    const session = { page, token }, data = await this.request(session, `/accounts/${sellerId}/meta/`);
    if (id(data.sno) !== sellerId || typeof data.market?.name !== 'string' || !data.market.name.trim()) throw layout();
    const account = { store: data.market.name, storeId: id(data.market.sno) };
    if (expected && (expected.store !== account.store || expected.storeId !== account.storeId)) throw new AppError('에이블리 판매자 계정이 변경되었습니다. 문의를 다시 조회해 주세요.', 409, 'STORE_CHANGED');
    return { session, ...account };
  }
  async request(session, endpoint, answer, { method = answer === undefined ? 'GET' : 'POST' } = {}) {
    if (!/^\/(?:accounts\/\d+\/meta\/|dashboard\/contact_room\/|contact_rooms\/)/.test(endpoint) || endpoint.includes('..')) throw layout();
    if (await this.token(session.page) !== session.token) throw login();
    const response = await session.page.context().request.fetch(origin + '/seller' + endpoint, {
      method, headers: { authorization: 'JWT ' + session.token, accept: 'application/json', origin: sellerOrigin, referer: sellerOrigin + '/' },
      ...(answer === undefined ? {} : { multipart: { content: answer } }), maxRedirects: 0, timeout: 25000,
    });
    try {
      if ([401, 403].includes(response.status())) throw login();
      const completing = method === 'POST' && /^\/contact_rooms\/\d+\/complete\/$/.test(endpoint);
      if (![200, 201, ...(completing ? [204] : [])].includes(response.status())) throw new AppError('에이블리 문의 요청을 처리하지 못했습니다. 상태를 새로고침해 주세요.', 502, 'ABLY_INQUIRY_FETCH');
      const data = await response.json().catch(() => null); if (data?.success === false || (!data && !completing)) throw layout(); return data || {};
    } finally { await response.dispose?.(); }
  }
  async summary() {
    const { session, ...account } = await this.identity();
    const items = parseAblyInquiryCounts(await this.request(session, '/dashboard/contact_room/?status%5B%5D=1&status%5B%5D=2&force_refresh=yes'));
    await this.identity(account); return { platform: 'ably', store: account.store, checkedAt: new Date().toISOString(), items };
  }
  async list(category, period = 'pending') {
    validCategory(category);
    const range = period === 'pending' ? { period } : coupangInquiryRange(period);
    const { session, ...account } = await this.identity(), params = new URLSearchParams({ order: '-updated_latest_message_at' });
    // Status 0 is an unfinished customer intake without a selected category; the seller UI excludes it.
    for (const status of period === 'pending' ? [1, 2] : [1, 2, 3, 4, 5]) params.append('status[]', String(status));
    if (range.from) { params.set('start_date', range.from); params.set('end_date', range.to); }
    const expected = count((await this.request(session, '/contact_rooms/total_count/?' + params)).total_count), records = [], seen = new Set(), cursors = new Set();
    for (let index = 0; ; index++) {
      if (index >= 150) throw new AppError('문의 조회 범위가 큽니다. 기간을 줄여 주세요.', 422, 'INQUIRY_LIMIT');
      const data = await this.request(session, '/contact_rooms/?' + params);
      if (!Array.isArray(data.contact_rooms) || typeof data.is_last !== 'boolean') throw layout();
      for (const row of data.contact_rooms) {
        const record = normalizeAblyRoom(row, account);
        if (seen.has(record.sourceId)) throw changed(); seen.add(record.sourceId);
        if (record.category === category) records.push(record);
      }
      if (data.is_last) break;
      const cursor = id(data.last_sno); if (!data.contact_rooms.length || cursors.has(cursor)) throw layout(); cursors.add(cursor); params.set('last_sno', cursor);
    }
    params.delete('last_sno');
    if (seen.size !== expected || count((await this.request(session, '/contact_rooms/total_count/?' + params)).total_count) !== expected) throw changed();
    await this.identity(account);
    return { platform: 'ably', category, store: account.store, range, checkedAt: new Date().toISOString(), records };
  }
  async detail(record) {
    const { session, ...account } = await this.identity(record), sourceId = id(record.sourceId), messages = [], seen = new Set(), cursors = new Set();
    let room, signature, cursor;
    for (let index = 0; ; index++) {
      if (index >= 150) throw new AppError('문의 대화가 너무 길어 조회를 중단했습니다.', 422, 'INQUIRY_LIMIT');
      const data = await this.request(session, `/contact_rooms/${sourceId}/` + (cursor ? '?first_sno=' + cursor : ''));
      if (!data.contact_room || !Array.isArray(data.contact_messages) || typeof data.is_first !== 'boolean') throw layout();
      const current = normalizeAblyRoom(data.contact_room, account, { sourceId });
      if (current.category !== record.category || current.meta.customerId !== record.meta.customerId || current.meta.childCategory !== record.meta.childCategory) throw changed();
      const nextSignature = JSON.stringify([current.meta, current.date]);
      signature ??= nextSignature; if (signature !== nextSignature) throw changed(); room ??= data.contact_room;
      for (const raw of data.contact_messages) {
        const message = normalizeAblyMessage(raw); if (seen.has(message.id)) throw changed(); seen.add(message.id); messages.push(message);
        // Embedded order cards carry the order context when the room itself only contains an empty object.
        if (raw.order_item?.sno && !room.order_item?.sno) room.order_item = raw.order_item;
        if (raw.goods?.sno && !room.goods?.sno) room.goods = raw.goods;
      }
      if (data.is_first) break;
      cursor = id(data.first_sno); if (!data.contact_messages.length || cursors.has(cursor)) throw layout(); cursors.add(cursor);
    }
    await this.identity(account); return normalizeAblyRoom(room, account, { sourceId, messages, detailed: true });
  }
  async reply(record, answer, beforeSend) {
    const { session } = await this.identity(record);
    if (!record.detailed || !record.canReply || ![1, 2, 3].includes(record.meta.roomStatus) || typeof answer !== 'string' || !answer.trim() || answer.length > 3000) throw new AppError('답변할 수 없는 문의이거나 답변 길이가 올바르지 않습니다.', 409);
    await beforeSend();
    const result = await this.request(session, `/contact_rooms/${id(record.sourceId)}/send/`, answer);
    return { messageId: id(result.sno) };
  }
  async complete(record, beforeSend) {
    const { session } = await this.identity(record);
    if (!record.detailed || !record.canComplete || ![1, 2].includes(record.meta.roomStatus)) throw new AppError('현재 완료 처리할 수 없는 문의입니다. 내용을 새로고침해 주세요.', 409, 'INQUIRY_NOT_COMPLETABLE');
    await beforeSend();
    await this.request(session, `/contact_rooms/${id(record.sourceId)}/complete/`, undefined, { method: 'POST' });
  }
  async open(category) {
    validCategory(category); const { session } = await this.identity(), context = session.page.context();
    let page = context.pages().find(p => p.url() === sellerOrigin + '/inquiry');
    if (!page) { page = await context.newPage(); try { await page.goto(sellerOrigin + '/inquiry', { waitUntil: 'domcontentloaded', timeout: 25000 }); } catch (e) { await page.close().catch(() => {}); throw e; } }
    await page.bringToFront(); return { opened: true, category };
  }
}
