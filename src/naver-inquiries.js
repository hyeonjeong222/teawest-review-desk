import { AppError } from './core.js';

const origin = 'https://sell.smartstore.naver.com';
// Read endpoint and menu routes observed in the signed-in seller dashboard.
const summaryUrl = `${origin}/api/v1/sellers/dashboards/inquiries`;
export const inquiryCategories = [
  { id: 'talktalk', label: '톡톡 문의', field: 'talktalkInquiryCount', route: '/talktalk/chat' },
  { id: 'customer', label: '주문 고객 문의', field: 'customerInquiryCount', route: '/naverpay/qnas' },
  { id: 'product', label: '상품 Q&A', field: 'productInquiryCount', route: '/comment/' },
  { id: 'center', label: '고객센터', field: 'csTicketCount', route: '/seller/customer-center-cs' },
];

export function parseInquiryCounts(data) {
  return inquiryCategories.map(({ id, label, field }) => {
    const value = data?.[field];
    const valid = typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0
      : typeof value === 'string' && /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value.trim());
    const count = valid ? Number(String(value).replaceAll(',', '').trim()) : NaN;
    if (!Number.isSafeInteger(count) || count < 0) throw new AppError('네이버 문의 건수를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.', 502, 'INQUIRY_LAYOUT');
    return { id, label, count };
  });
}

export class NaverInquiryService {
  constructor(connector, queue) { this.connector = connector; this.queue = queue; this.snapshot = null; this.pending = null; }
  publicState() { return this.snapshot || { platform: 'naver', store: null, checkedAt: null, items: inquiryCategories.map(({ id, label }) => ({ id, label, count: null })) }; }
  sync() {
    if (this.pending) return this.pending;
    this.pending = this.queue.run(async () => {
      const before = await this.connector.status(true);
      if (before.networkError) throw new AppError('네이버 연결을 확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 갱신해 주세요.', 502, 'INQUIRY_FETCH');
      if (!before.connected || !before.store) throw new AppError('네이버 연결 창에서 로그인과 추가 인증을 완료한 뒤 다시 확인해 주세요.', 409, 'LOGIN_REQUIRED');
      const page = await this.connector.getPage();
      let response;
      try {
        response = await page.request.get(summaryUrl, { timeout: 20000, maxRedirects: 0 });
        if ([301, 302, 303, 307, 308, 401, 403].includes(response.status())) throw new AppError('네이버 로그인을 다시 확인해 주세요.', 409, 'LOGIN_REQUIRED');
        if (response.status() !== 200) throw new AppError('네이버 문의 현황을 가져오지 못했습니다. 잠시 후 다시 확인해 주세요.', 502, 'INQUIRY_FETCH');
        const data = await response.json().catch(() => { throw new AppError('네이버 문의 응답을 확인하지 못했습니다.', 502, 'INQUIRY_LAYOUT'); });
        const items = parseInquiryCounts(data);
        const after = await this.connector.status(true);
        if (after.networkError) throw new AppError('네이버 연결 확인에 실패했습니다. 다시 갱신해 주세요.', 502, 'INQUIRY_FETCH');
        if (!after.connected) throw new AppError('네이버 로그인을 다시 확인해 주세요.', 409, 'LOGIN_REQUIRED');
        if (after.store !== before.store) { this.snapshot = null; throw new AppError('네이버 스토어가 변경되었습니다. 스토어를 확인하고 다시 갱신해 주세요.', 409, 'STORE_CHANGED'); }
        // Only summary counts leave the connector; chat IDs and customer text are discarded.
        this.snapshot = { platform: 'naver', store: before.store, checkedAt: new Date().toISOString(), items };
        return this.publicState();
      } finally { await response?.dispose?.(); }
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async open(category) {
    const target = inquiryCategories.find(item => item.id === category);
    if (!target) throw new AppError('지원하지 않는 네이버 문의 항목입니다.', 400, 'INVALID_INQUIRY_CATEGORY');
    return this.queue.run(async () => {
      const status = await this.connector.status(true);
      if (status.networkError) throw new AppError('네이버 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.', 502, 'INQUIRY_FETCH');
      if (!status.connected) {
        await this.connector.open();
        return { opened: false, loginRequired: true };
      }
      const browser = await this.connector.connect(), context = browser.contexts()[0];
      const url = `${origin}/#${target.route}`;
      // Reuse an exact matching inquiry tab; never navigate the review editor away.
      let page = context.pages().find(p => p.url() === url);
      if (!page) {
        page = await context.newPage();
        try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
        catch (error) { await page.close().catch(() => {}); throw error; }
      }
      await page.bringToFront();
      return { opened: true, category: target.id };
    });
  }
}
