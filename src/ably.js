import { NaverConnector } from './naver.js';
import { AppError } from './core.js';
import { coupangDateRange } from './coupang.js';
import { loginAblyWithCredentials } from './ably-login.js';

export const ABLY_REVIEW_URL = 'https://my.a-bly.com/reviews';
const API_URL = 'https://api.a-bly.com/seller/reviews/';
const IMAGE_HOST = 'd3ha2047wt6x28.cloudfront.net';
const PAGE_SIZE = 30;
const layoutError = () => new AppError('에이블리 리뷰 형식이 변경되었습니다. 기존 목록은 유지됩니다.', 502, 'ABLY_LAYOUT');
const loginError = () => new AppError('에이블리 판매자센터에서 로그인과 추가 인증을 완료한 뒤 다시 가져와 주세요.', 409, 'ABLY_LOGIN_REQUIRED');

export function normalizeAblyReview(raw, store) {
  if (!Number.isSafeInteger(raw.sno) || raw.sno <= 0 || !Number.isSafeInteger(raw.goods?.sno) || typeof raw.goods.name !== 'string' || typeof raw.contents !== 'string' || typeof raw.satisfaction !== 'boolean' || !Array.isArray(raw.images) || !Number.isInteger(raw.status) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw.created_at)) throw layoutError();
  // The seller UI returns local Korean date/time without a timezone suffix.
  const dateTimestamp = Date.parse(`${raw.created_at}+09:00`);
  if (!Number.isFinite(dateTimestamp)) throw layoutError();
  const hidden = raw.status !== 1;
  const media = hidden ? [] : raw.images.filter(url => {
    try { const parsed = new URL(url); return parsed.protocol === 'https:' && parsed.hostname === IMAGE_HOST && !parsed.username && !parsed.password; } catch { return false; }
  });
  return { id: `ably-${raw.sno}`, sourceId: String(raw.sno), platform: 'ably', readOnly: true,
    productId: String(raw.goods.sno), product: raw.goods.name, productUrl: null,
    content: hidden ? '에이블리에서 비공개 처리된 리뷰입니다.' : raw.contents,
    rating: null, satisfaction: raw.satisfaction, author: '구매자',
    date: raw.created_at.slice(0, 19).replaceAll('-', '.').replace('T', ' '), dateTimestamp,
    media: [...new Set(media)], store, status: hidden ? '비공개' : '정상', hasReply: false, reply: null };
}

// Review operations are read-only. Login uses the official form; authentication stays in memory.
export class AblyConnector {
  constructor(directory, host = new NaverConnector(directory)) { this.host = host; }
  async getPage(create = false) {
    const browser = await this.host.connect(), context = browser.contexts()[0];
    let page = context.pages().find(p => p.url().startsWith('https://my.a-bly.com/'));
    if (!page && create) { page = await context.newPage(); await page.goto(ABLY_REVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    if (!page) throw loginError();
    return page;
  }
  async storeName(page) {
    if (!page.url().startsWith('https://my.a-bly.com/')) return null;
    return (await page.locator('a[href="/seller"]').first().textContent({ timeout: 2500 }).catch(() => ''))?.trim() || null;
  }
  async open(focus = true) {
    try { await this.host.connect(); } catch { await this.host.open(false); }
    const page = await this.getPage(true); this.session = null; this.probe = null;
    if (focus) await page.bringToFront();
    return this.status(true);
  }
  async login(credentials) { return loginAblyWithCredentials(this, credentials); }
  async workspace() {
    if (this.preparing) return this.preparing;
    this.preparing = this.prepareWorkspace();
    try { return await this.preparing; } finally { this.preparing = null; }
  }
  async prepareWorkspace() {
    const page = await this.getPage(), store = await this.storeName(page);
    if (!store) { this.session = null; throw loginError(); }
    if (this.session?.page === page && this.session.store === store) return this.session;
    const pending = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin + url.pathname === API_URL && response.request().method() === 'GET';
    }, { timeout: 20000 }).catch(() => null);
    await page.goto(ABLY_REVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const response = await pending;
    if (!response || [401, 403].includes(response.status()) || !await this.storeName(page)) throw loginError();
    if (response.status() !== 200) throw new AppError('에이블리 리뷰 서버에 연결하지 못했습니다.', 502, 'ABLY_SEARCH_FAILED');
    const authorization = await response.request().headerValue('authorization');
    if (!authorization) throw loginError();
    const afterStore = await this.storeName(page);
    if (afterStore !== store) throw new AppError('조회 중 에이블리 판매자 계정이 변경되었습니다. 다시 연결해 주세요.', 409, 'STORE_CHANGED');
    this.session = { page, store, authorization };
    return this.session;
  }
  async fetchPage(session, index) {
    const url = new URL(API_URL);
    url.search = new URLSearchParams({ page: String(index), per_page: String(PAGE_SIZE), order_by: 'LATEST' }).toString();
    const response = await session.page.context().request.get(url.href, {
      headers: { authorization: session.authorization, accept: 'application/json', origin: 'https://my.a-bly.com', referer: 'https://my.a-bly.com/' },
      maxRedirects: 0, timeout: 20000,
    });
    try {
      if ([401, 403].includes(response.status())) { this.session = null; this.probe = null; throw loginError(); }
      if (response.status() !== 200) throw new AppError('에이블리 리뷰 조회에 실패했습니다. 잠시 후 다시 시도해 주세요. 기존 목록은 유지됩니다.', 502, 'ABLY_SEARCH_FAILED');
      const data = await response.json().catch(() => null);
      if (!Array.isArray(data?.reviews) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) throw layoutError();
      return data;
    } finally { await response.dispose?.(); }
  }
  async status(force = false) {
    try {
      const page = await this.getPage(), store = await this.storeName(page);
      if (!store) { this.session = null; this.probe = null; return { connected: false, browserOpen: true, store: null }; }
      if (force || !this.probe || this.probe.store !== store || Date.now() - this.probe.at > 60000) {
        await this.fetchPage(await this.workspace(), 1); this.probe = { store, at: Date.now() };
      }
      return { connected: true, browserOpen: true, store };
    } catch (error) {
      return { connected: false, browserOpen: error.code !== 'BROWSER_REQUIRED', networkError: !['BROWSER_REQUIRED', 'ABLY_LOGIN_REQUIRED'].includes(error.code), store: null };
    }
  }
  async sync(period = '3m', now = new Date()) {
    const range = coupangDateRange(period, now), session = await this.workspace(), collected = new Map();
    let sourceTotal;
    for (let index = 1; ; index++) {
      if (index > 300) throw new AppError('에이블리 전체 리뷰가 너무 많아 조회를 중단했습니다. 기존 목록은 유지됩니다.', 422, 'ABLY_PAGE_LIMIT');
      const data = await this.fetchPage(session, index);
      sourceTotal ??= data.total_count;
      if (sourceTotal !== data.total_count) throw new AppError('조회 중 에이블리 리뷰 수가 변경되었습니다. 다시 시도해 주세요.', 409, 'ABLY_CHANGED');
      const expected = Math.min(PAGE_SIZE, sourceTotal - (index - 1) * PAGE_SIZE);
      if (data.reviews.length !== expected) throw new AppError('에이블리 리뷰 일부를 읽지 못했습니다. 기존 목록은 유지됩니다.', 502, 'INCOMPLETE_SYNC');
      for (const raw of data.reviews) { const review = normalizeAblyReview(raw, session.store); collected.set(review.id, review); }
      if (index * PAGE_SIZE >= sourceTotal) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (collected.size !== sourceTotal) throw new AppError('에이블리 리뷰 목록이 중복되거나 변경되었습니다. 다시 시도해 주세요.', 409, 'ABLY_CHANGED');
    if (await this.storeName(session.page) !== session.store) throw new AppError('에이블리 판매자 계정이 변경되었습니다. 다시 연결해 주세요.', 409, 'STORE_CHANGED');
    // LATEST is modification order, so read every page before filtering by creation date.
    const reviews = [...collected.values()].filter(r => { const day = r.date.slice(0, 10).replaceAll('.', '-'); return day >= range.from && day <= range.to; });
    this.probe = { store: session.store, at: Date.now() };
    return { reviews, total: reviews.length, sourceTotal, store: session.store, period, ...range, readOnly: true };
  }
}
