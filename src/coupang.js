import { NaverConnector } from './naver.js';
import { AppError } from './core.js';
import { COUPANG_ORIGIN, COUPANG_AUTH_ORIGIN, isCoupangPage, loginCoupangWithCredentials } from './coupang-login.js';

export const COUPANG_REVIEW_URL = 'https://wing.coupang.com/tenants/cs/product/review';
const SEARCH_PATH = '/tenants/cs/product/review/search';
const dayMs = 86400000;
export function coupangDateRange(period, now = new Date()) {
  const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[period];
  if (!months) throw new AppError('지원하지 않는 조회 기간입니다.');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const to = new Date(`${today}T00:00:00Z`), from = new Date(to);
  const day = from.getUTCDate(); from.setUTCDate(1); from.setUTCMonth(from.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate();
  from.setUTCDate(Math.min(day, lastDay)); from.setUTCDate(from.getUTCDate() + 1);
  return { from: from.toISOString().slice(0, 10), to: today };
}
export function coupangDateWindows(from, to) {
  const windows = [], lower = Date.parse(`${from}T00:00:00Z`);
  // 28 inclusive days always fit Wing's one-calendar-month maximum, including February.
  for (let end = Date.parse(`${to}T00:00:00Z`); end >= lower;) {
    const start = Math.max(lower, end - 27 * dayMs);
    windows.push({ from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) }); end = start - dayMs;
  }
  return windows;
}
export function normalizeCoupangReview(raw, store) {
  if (!Number.isSafeInteger(raw.reviewId) || !Number.isSafeInteger(raw.productId) || !Number.isFinite(raw.reviewAt) || !Number.isInteger(raw.rating) || raw.rating < 1 || raw.rating > 5) throw new AppError('쿠팡 리뷰 형식이 변경되었습니다. 기존 목록을 유지합니다.', 502, 'COUPANG_LAYOUT');
  let attachment; try { attachment = JSON.parse(raw.attachment || '{}'); } catch { attachment = {}; }
  const media = (Array.isArray(attachment?.imageAttachments) ? attachment.imageAttachments : []).flatMap(item => {
    const candidates = typeof item === 'string' ? [item] : Object.values(item || {}).filter(v => typeof v === 'string');
    return candidates.filter(url => { try { const parsed = new URL(url); return parsed.protocol === 'https:' && (parsed.hostname === 'coupangcdn.com' || parsed.hostname.endsWith('.coupangcdn.com')); } catch { return false; } });
  });
  const hidden = raw.deleted || raw.blinded;
  const content = hidden ? '쿠팡에서 비공개 또는 삭제 처리된 리뷰입니다.' : [raw.reviewTitle, raw.reviewContent].filter(t => typeof t === 'string' && t.trim()).filter((t, i, values) => values.indexOf(t) === i).join('\n\n');
  const author = String(raw.memberName || '').trim();
  return { id: `coupang-${raw.reviewId}`, sourceId: String(raw.reviewId), platform: 'coupang', readOnly: true, productId: String(raw.productId), product: String(raw.itemName || '상품명 없음'), content,
    rating: raw.rating, author: author ? `${Array.from(author)[0]}***` : '구매자', date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(raw.reviewAt)).replaceAll('-', '.'), dateTimestamp: raw.reviewAt,
    hasReply: false, reply: null, media: hidden ? [] : [...new Set(media)], store, status: hidden ? '비공개' : '정상', productUrl: `https://www.coupang.com/vp/products/${raw.productId}` };
}

// Reviews are read-only. Login submits only the official authentication form.
export class CoupangConnector {
  constructor(directory, host = new NaverConnector(directory)) { this.host = host; this.sessionProbe = null; }
  async connect() { return this.host.connect(); }
  async getPage(create = false) {
    const browser = await this.connect(), context = browser.contexts()[0];
    let page = context.pages().find(p => p.url().startsWith('https://wing.coupang.com/')) || context.pages().find(p => p.url().startsWith('https://xauth.coupang.com/'));
    if (this.authPage && !this.authPage.isClosed() && isCoupangPage(this.authPage.url())) page = this.authPage;
    if (!page && create) { page = await context.newPage(); await page.goto(COUPANG_REVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    if (!page) throw new AppError('쿠팡 연결 창을 열어 쿠팡윙에 로그인해 주세요.', 409, 'COUPANG_LOGIN_REQUIRED');
    return page;
  }
  async open(focus = true) {
    try { await this.connect(); } catch { await this.host.open(false); }
    const page = await this.getPage(true);
    if (page.url().startsWith('https://wing.coupang.com/')) await page.goto(COUPANG_REVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    this.sessionProbe = null;
    if (focus) await page.bringToFront(); return this.status(true);
  }
  async status(force = false) {
    try {
      const page = await this.getPage();
      const title = await page.title();
      const header = page.url().startsWith('https://wing.coupang.com/') && (title.startsWith('Coupang Wing -') || await page.locator('a[href="/tenants/cs/product/review"]').count() > 0);
      if (!header) { this.sessionProbe = null; return { connected: false, browserOpen: true, store: null }; }
      if (force || !this.sessionProbe || Date.now() - this.sessionProbe.at > 60000) {
        // A stale page can keep its logged-in title after the server session expires.
        const response = await page.context().request.get(COUPANG_REVIEW_URL, { maxRedirects: 0, timeout: 7000 });
        try {
          const status = response.status(), location = response.headers().location;
          const redirect = location ? new URL(location, COUPANG_ORIGIN) : null;
          const loginRedirect = redirect && ((['https://wing.coupang.com', 'http://wing.coupang.com'].includes(redirect.origin) && redirect.pathname === '/login') || redirect.origin === COUPANG_AUTH_ORIGIN);
          if (status === 200 && response.headers()['content-type']?.includes('text/html')) this.sessionProbe = { connected: true, at: Date.now() };
          else if (status === 401 || ([301, 302, 303, 307, 308].includes(status) && loginRedirect)) this.sessionProbe = { connected: false, at: Date.now() };
          else return { connected: false, browserOpen: true, networkError: true, store: null };
        } finally { await response.dispose?.(); }
      }
      const connected = this.sessionProbe.connected;
      const store = title.includes(',') ? title.slice(title.lastIndexOf(',') + 1).trim() : '쿠팡윙';
      return { connected, browserOpen: true, store: connected ? store : null };
    } catch (e) { return { connected: false, browserOpen: e.code !== 'BROWSER_REQUIRED', networkError: !['BROWSER_REQUIRED', 'COUPANG_LOGIN_REQUIRED'].includes(e.code), store: null }; }
  }
  async login(credentials) {
    const browser = await this.connect().catch(() => null);
    if (!browser) await this.host.open(false);
    const context = (await this.connect()).contexts()[0];
    const observe = p => { if (isCoupangPage(p.url())) this.authPage = p; else p.once('domcontentloaded', () => { if (isCoupangPage(p.url())) this.authPage = p; }); };
    context.on('page', observe);
    try { return await loginCoupangWithCredentials(this, credentials); }
    finally { context.off('page', observe); }
  }
  async workspace() {
    const page = await this.getPage();
    if (!page.url().startsWith('https://wing.coupang.com/')) throw new AppError('쿠팡 연결 창에서 로그인과 추가 인증을 완료해 주세요.', 409, 'COUPANG_LOGIN_REQUIRED');
    if (!page.url().startsWith(COUPANG_REVIEW_URL)) await page.goto(COUPANG_REVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('a[href="/tenants/cs/product/review"]').first().waitFor({ state: 'attached', timeout: 15000 });
    const status = await this.status(true);
    if (!status.connected) throw new AppError('쿠팡 연결 창에서 다시 로그인해 주세요.', 409, 'COUPANG_LOGIN_REQUIRED');
    return { page, store: status.store };
  }
  async fetchPage(page, window, pageIndex) {
    const response = await page.evaluate(async ({ endpoint, body }) => {
      if (location.origin !== 'https://wing.coupang.com') return { status: 401 };
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, data: await res.json().catch(() => null) };
      } catch { return { status: 0 }; } finally { clearTimeout(timer); }
    }, { endpoint: SEARCH_PATH, body: { startTime: window.from, endTime: window.to, rating: '', salesStatus: '', advancedType: 'productName', advancedInput: '', pageIndex, pageSize: 50, productName: '' } });
    if ([401, 403].includes(response.status)) { this.sessionProbe = null; throw new AppError('쿠팡 로그인이 만료되었거나 조회 권한이 없습니다. 연결 창에서 확인해 주세요.', 409, 'COUPANG_LOGIN_REQUIRED'); }
    if (response.status !== 200 || response.data?.success !== true || !Array.isArray(response.data?.data?.content)) throw new AppError('쿠팡 리뷰를 조회하지 못했습니다. 연결 창의 로그인 상태를 확인한 뒤 다시 시도해 주세요. 기존 목록은 유지됩니다.', 502, 'COUPANG_SEARCH_FAILED');
    return response.data.data;
  }
  async sync(period = '3m') {
    const range = coupangDateRange(period), { page, store } = await this.workspace();
    const collected = new Map(); let total = 0, requests = 0, vendor = null;
    for (const window of coupangDateWindows(range.from, range.to)) {
      const windowIds = new Set(); let expected, pages;
      for (let pageIndex = 0; ; pageIndex++) {
        if (++requests > 300) throw new AppError('쿠팡 조회 페이지가 많습니다. 기간을 줄여 주세요. 기존 목록은 유지됩니다.', 422, 'COUPANG_PAGE_LIMIT');
        const data = await this.fetchPage(page, window, pageIndex), pagination = data.pagination;
        if (!pagination || !Number.isInteger(pagination.totalElements) || pagination.totalElements < 0 || !Number.isInteger(pagination.totalPages) || pagination.totalPages < 0 || (pagination.totalElements > 0 && pagination.totalPages < 1) || pagination.currentPage !== pageIndex) throw new AppError('쿠팡 페이지 정보를 확인하지 못했습니다.', 502, 'COUPANG_LAYOUT');
        if (pageIndex === 0) { expected = pagination.totalElements; pages = pagination.totalPages; }
        if (expected !== pagination.totalElements || pages !== pagination.totalPages) throw new AppError('조회 중 쿠팡 리뷰 수가 변경되었습니다. 다시 시도해 주세요.', 409, 'COUPANG_CHANGED');
        for (const raw of data.content) {
          if (!raw.vendorId || (vendor && raw.vendorId !== vendor)) throw new AppError('쿠팡 판매자 계정이 변경되었습니다. 다시 연결해 주세요.', 409, 'STORE_CHANGED');
          vendor = raw.vendorId;
          const review = normalizeCoupangReview(raw, store); windowIds.add(review.id); collected.set(review.id, review);
        }
        if (pageIndex + 1 >= pages) break;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (windowIds.size !== expected) throw new AppError('쿠팡 리뷰 일부를 읽지 못했습니다. 기존 목록을 유지합니다.', 502, 'INCOMPLETE_SYNC');
      total += expected;
    }
    if (collected.size !== total) throw new AppError('쿠팡 리뷰 조회 기간이 중복되었거나 목록이 변경되었습니다. 다시 시도해 주세요.', 409, 'COUPANG_CHANGED');
    return { reviews: [...collected.values()], total, store, period, ...range, readOnly: true };
  }
}
