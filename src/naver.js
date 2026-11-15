import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { AppError, assertSameReview, SerialQueue } from './core.js';
import { readRenderedRows, readReviewDetail } from './naver-dom.js';
import { REVIEW_URL, isNaverPage, loginWithCredentials } from './naver-login.js';

const periods = { '1m': '1개월', '3m': '3개월', '6m': '6개월', '1y': '1년' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Naver renders its dialog through an outer-frame overlay. Its inner-frame buttons
// can be outside Playwright's viewport coordinates while visibly on screen.
async function clickDialogButton(frame, label) {
  const button = frame.locator('button').filter({ hasText: new RegExp(`^${label}$`) });
  if (await button.count() !== 1) throw new AppError('네이버 화면이 변경되었습니다. 대상 버튼을 확인할 수 없습니다.', 503, 'NAVER_LAYOUT');
  await button.evaluate(e => { if (e.disabled || !e.getClientRects().length) throw new Error('Button unavailable'); e.click(); });
}
export async function dismissReplySuccess(frame) {
  // This is a completed-operation notice, not a confirmation to send a reply.
  const notices = frame.locator('.mst-modal-root').filter({ hasText: '답글이 등록되었습니다.' });
  for (let i = 0; i < await notices.count(); i++) {
    const notice = notices.nth(i);
    const button = notice.locator('button').filter({ hasText: /^확인$/ });
    // Naver's root has a zero-size box while its portal child is visible.
    if (await button.count() !== 1 || !await button.isVisible()) continue;
    const text = (await notice.innerText()).replace(/\s+/g, '');
    if (text !== '답글이등록되었습니다.확인') continue;
    await clickDialogButton(notice, '확인');
    await button.waitFor({ state: 'hidden', timeout: 5000 }); return true;
  }
  return false;
}
export class NaverConnector {
  constructor(directory, endpoint = process.env.NAVER_CDP_URL || 'http://127.0.0.1:9337') {
    this.directory = directory; this.endpoint = endpoint; this.openQueue = new SerialQueue();
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('NAVER_CDP_URL must be a loopback HTTP URL.');
  }
  async connect() {
    if (this.browser?.isConnected()) return this.browser;
    // All stores share one browser. Concurrent status/login checks must share
    // the attachment too, or each one initializes every open store tab again.
    if (!this.connecting) this.connecting = chromium.connectOverCDP(this.endpoint, { timeout: 15000, noDefaults: true })
      .then(browser => { this.browser = browser; return browser; })
      .catch(() => { throw new AppError('연결 창을 먼저 열고 로그인해 주세요.', 409, 'BROWSER_REQUIRED'); })
      .finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async open(focus = true) {
    return this.openQueue.run(async () => {
      try { await this.connect(); } catch {
        const candidates = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
        let executable;
        for (const p of candidates) { try { await access(p); executable = p; break; } catch {} }
        if (!executable) throw new AppError('Chrome 또는 Edge를 찾지 못했습니다. CHROME_PATH를 설정해 주세요.', 503, 'BROWSER_MISSING');
        const profile = path.join(this.directory, 'naver-browser'); await mkdir(profile, { recursive: true });
        const child = spawn(executable, [`--remote-debugging-port=${new URL(this.endpoint).port || '9337'}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', REVIEW_URL], { detached: true, stdio: 'ignore', windowsHide: false });
        child.on('error', () => {}); child.unref();
        for (let i = 0; i < 16; i++) { await pause(500); try { await this.connect(); break; } catch {} }
        if (!this.browser?.isConnected()) throw new AppError('연결 창을 열지 못했습니다. Chrome 실행 상태를 확인해 주세요.', 503, 'BROWSER_OPEN_FAILED');
      }
      const page = await this.getPage(true); if (focus) await page.bringToFront(); return this.status();
    });
  }
  async getPage(create = false) {
    const browser = await this.connect(); const context = browser.contexts()[0];
    const candidates = context.pages().filter(p => isNaverPage(p.url()));
    let page = candidates.find(p => p.url().startsWith('https://sell.smartstore.naver.com/') && !p.url().includes('#/login')) || candidates.at(-1);
    // Keep the actual challenge/popup available for the user to finish.
    if (this.authPage && !this.authPage.isClosed() && isNaverPage(this.authPage.url())) page = this.authPage;
    if (!page && create) { page = await context.newPage(); await page.goto(REVIEW_URL, { waitUntil: 'domcontentloaded' }); }
    if (!page) throw new AppError('네이버 연결 창에서 스마트스토어센터에 로그인해 주세요.', 409, 'LOGIN_REQUIRED');
    return page;
  }
  async status(force = false) {
    try {
      const page = await this.getPage();
      const store = (await page.locator('span.shop').first().textContent({ timeout: 1600 }).catch(() => ''))?.trim();
      if (!store || !page.url().startsWith('https://sell.smartstore.naver.com/')) return { connected: false, browserOpen: true, store: null };
      // The header can remain visible after server-side session expiry. This observed,
      // read-only endpoint returns no access keys when signed out. Cache for one minute.
      if (force || !this.sessionProbe || Date.now() - this.sessionProbe.at > 60000) {
        const response = await page.context().request.get('https://sell.smartstore.naver.com/api/context', { timeout: 7000, maxRedirects: 0 });
        try {
          const data = await response.json().catch(() => null);
          if (response.status() === 401) this.sessionProbe = { at: Date.now(), connected: false };
          else {
            if (response.status() !== 200 || !Array.isArray(data?.menuAccessKeyTypes)) return { connected: false, browserOpen: true, networkError: true, store: null };
            this.sessionProbe = { at: Date.now(), connected: data.menuAccessKeyTypes.length > 0 };
          }
        } finally { await response.dispose?.(); }
      }
      return { connected: this.sessionProbe.connected, browserOpen: true, store: this.sessionProbe.connected ? store : null };
    } catch (e) { return { connected: false, browserOpen: e.code !== 'BROWSER_REQUIRED', networkError: !['LOGIN_REQUIRED', 'BROWSER_REQUIRED'].includes(e.code), store: null }; }
  }
  async login(credentials) {
    await this.open(false);
    const browser = await this.connect();
    const observe = p => { if (isNaverPage(p.url())) this.authPage = p; else p.once('domcontentloaded', () => { if (isNaverPage(p.url())) this.authPage = p; }); };
    browser.contexts()[0].on('page', observe);
    try { return await loginWithCredentials(this, credentials); }
    finally { browser.contexts()[0].off('page', observe); }
  }
  async workspace() {
    const page = await this.getPage();
    const { connected, store } = await this.status(true);
    if (!connected) throw new AppError('네이버 연결을 복구 중이거나 추가 인증이 필요합니다. 연결 상태를 확인한 뒤 다시 눌러 주세요. 초안은 보관됩니다.', 409, 'LOGIN_REQUIRED');
    if (!page.url().includes('/review/search')) await page.goto(REVIEW_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('iframe[src="/mg/contents/review/search"]').waitFor({ timeout: 15000 });
    const frame = page.frames().find(f => f.url().includes('/mg/contents/review/search'));
    if (!frame) throw new AppError('리뷰 관리 화면을 찾지 못했습니다.', 503, 'NAVER_LAYOUT');
    await frame.locator('button').filter({ hasText: /^검색$/ }).waitFor({ timeout: 15000 });
    return { page, frame, store };
  }
  async closeDetails(frame) {
    await dismissReplySuccess(frame);
    const detail = frame.locator('textarea[placeholder^="반복적인 답글"]');
    if (await detail.count()) {
      const data = await frame.evaluate(readReviewDetail);
      if (!data.hasReply && data.reply.trim()) throw new AppError('네이버 연결 창에 작성 중인 답글이 있습니다. 먼저 저장 여부를 결정하고 창을 닫아 주세요.', 409, 'UNSAVED_NAVER_DRAFT');
      await clickDialogButton(frame, '닫기');
    }
    if (await frame.locator('#reviewComment').count()) throw new AppError('네이버의 일괄 답글 창을 닫고 다시 시도해 주세요.', 409, 'NAVER_DIALOG_OPEN');
  }
  async search(frame, id) {
    const before = await frame.evaluate(() => document.querySelector('.ag-center-cols-container')?.innerText || '');
    await frame.getByRole('button', { name: '검색', exact: true }).click();
    // Wait for the grid to settle; re-check the expected ID before any publishing action.
    await pause(900);
    await frame.waitForFunction(() => /리뷰목록/.test(document.body.innerText), null, { timeout: 15000 });
    if (id) await frame.locator(`.ag-center-cols-container [row-id="${id}"]`).waitFor({ timeout: 12000 });
    let previous = before, stable = 0;
    for (let i = 0; i < 20; i++) { const now = await frame.evaluate(() => document.querySelector('.ag-center-cols-container')?.innerText || ''); if (now === previous) stable++; else stable = 0; previous = now; if (stable >= 2) break; await pause(200); }
  }
  async reset(frame, period) {
    await this.closeDetails(frame);
    await frame.getByRole('button', { name: '초기화', exact: true }).click();
    await frame.getByRole('button', { name: periods[period] || periods['3m'], exact: true }).click();
  }
  async sync(period = '3m') {
    if (!periods[period]) throw new AppError('지원하지 않는 조회 기간입니다.');
    const { frame, store } = await this.workspace(); await this.reset(frame, period); await this.search(frame);
    const total = await frame.evaluate(() => { const match = document.body.innerText.match(/리뷰목록\s*\(총\s*([\d,]+)개\)/); return match ? Number(match[1].replaceAll(',', '')) : null; });
    if (!Number.isSafeInteger(total) || total < 0) throw new AppError('네이버 리뷰 건수를 확인하지 못했습니다. 기존 목록을 유지합니다.', 502, 'NAVER_LAYOUT');
    const collected = new Map(); let pages = 0;
    do {
      await frame.evaluate(() => { for (const e of document.querySelectorAll('.ag-body-viewport,.ag-body-vertical-scroll-viewport')) e.scrollTop = 0; });
      await pause(150);
      for (let step = 0; step < 800; step++) {
        for (const review of await frame.evaluate(readRenderedRows)) collected.set(review.id, { ...review, store });
        const end = await frame.evaluate(() => { const e = document.querySelector('.ag-body-viewport'); if (!e || e.scrollTop + e.clientHeight >= e.scrollHeight - 2) return true; const top = Math.min(e.scrollHeight - e.clientHeight, e.scrollTop + Math.max(150, e.clientHeight * 0.6)); for (const v of document.querySelectorAll('.ag-body-viewport,.ag-body-vertical-scroll-viewport')) { v.scrollTop = top; v.dispatchEvent(new Event('scroll', { bubbles: true })); } return false; });
        if (end) {
          // A virtual grid can reach its scroll boundary before the final rows render.
          // Re-read the settled tail before accepting this page as complete.
          for (let tail = 0; tail < 3; tail++) { await pause(250); for (const review of await frame.evaluate(readRenderedRows)) collected.set(review.id, { ...review, store }); }
          break;
        }
        await pause(150);
      }
      pages++;
      const next = frame.locator('[data-testid="DetailPagination__nextBtn"]');
      if (!(await next.count()) || await next.isDisabled() || collected.size >= total || pages >= 100) break;
      const firstId = await frame.locator('.ag-center-cols-container [row-id]').first().getAttribute('row-id');
      await next.click(); await frame.waitForFunction(id => document.querySelector('.ag-center-cols-container [row-id]')?.getAttribute('row-id') !== id, firstId, { timeout: 15000 });
    } while (true);
    const dates = await frame.locator('input.date-picker-input').evaluateAll(els => els.map(e => e.value));
    if (collected.size !== total) throw new AppError(`네이버에는 ${total}건이 있지만 ${collected.size}건만 읽었습니다. 기존 목록을 유지합니다. 다시 동기화해 주세요.`, 502, 'INCOMPLETE_SYNC');
    return { reviews: Array.from(collected.values()), total, store, period, from: dates[0], to: dates[1] };
  }
  async locate(expected) {
    const { page, frame, store } = await this.workspace();
    if (store !== expected.store) throw new AppError('연결된 스토어가 다릅니다. 원래 스토어를 선택해 주세요.', 409, 'STORE_CHANGED');
    await this.reset(frame, '1y');
    const combo = frame.getByRole('combobox').filter({ hasText: /^리뷰글번호$/ });
    if (await combo.count() !== 1) throw new AppError('리뷰 번호 검색 항목을 찾지 못했습니다.', 503, 'NAVER_LAYOUT');
    await frame.locator('textarea[placeholder^="복수 검색시"]').fill(expected.id);
    await this.search(frame, expected.id);
    const rows = await frame.evaluate(readRenderedRows); const row = rows.find(r => r.id === expected.id);
    const actual = row && { ...row, store }; assertSameReview(expected, actual);
    await frame.locator(`.ag-center-cols-container [row-id="${expected.id}"] [col-id="reviewContent"] a`).click();
    await frame.locator('textarea[placeholder^="반복적인 답글"]').waitFor();
    const detail = await frame.evaluate(readReviewDetail);
    if (detail.id !== expected.id) throw new AppError('열린 리뷰 번호가 다릅니다. 등록을 중단했습니다.', 409, 'REVIEW_CHANGED');
    return { page, frame, actual: { ...actual, ...detail } };
  }
  async detail(expected) { const { frame, actual } = await this.locate(expected); await this.closeDetails(frame); return actual; }
  async publish(expected, text, beforeClick) {
    const { page, frame, actual } = await this.locate(expected);
    if (actual.hasReply) { await this.closeDetails(frame); throw new AppError('네이버에 이미 답글이 등록되어 있습니다. 답글 확인을 눌러 주세요.', 409, 'ALREADY_REPLIED'); }
    const editor = frame.locator('textarea[placeholder^="반복적인 답글"]'); await editor.fill(text);
    const check = await frame.evaluate(readReviewDetail);
    if (check.id !== expected.id || check.reply !== text || check.hasReply) throw new AppError('등록 대상 또는 답글이 변경되었습니다.', 409, 'REVIEW_CHANGED');
    await beforeClick();
    const acceptReplyDialog = async dialog => { if (/답글|등록/.test(dialog.message())) await dialog.accept(); else await dialog.dismiss(); };
    page.on('dialog', acceptReplyDialog);
    try {
      await clickDialogButton(frame, '답글 등록');
      for (let i = 0; i < 30; i++) {
        await pause(300);
        // A success notice can hide the underlying detail or search from role locators.
        if (await dismissReplySuccess(frame)) break;
        const modified = frame.locator('button').filter({ hasText: /^답글 수정$/ });
        if (await modified.count()) break;
      }
      await this.closeDetails(frame);
      // Read it afresh from Naver after submission; a button click alone is not success.
      const verified = await this.locate(expected);
      if (!verified.actual.hasReply || verified.actual.reply !== text) throw new Error('Reply read-back mismatch');
      await this.closeDetails(verified.frame); return { reply: verified.actual.reply };
    } finally { page.off('dialog', acceptReplyDialog); }
  }
}
