import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base = 'http://127.0.0.1:4317';
const session = await fetch(`${base}/api/session`).then(r => r.json());
const before = await fetch(`${base}/api/reviews`).then(r => r.json());
const response = await fetch(`${base}/api/sync`, { method: 'POST', headers: { Origin: base, 'X-Review-Token': session.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'coupang', period: before.sync?.period || '3m' }) });
const data = await response.json(); assert.equal(response.status, 200, data.error);
const naver = r => (r.platform || 'naver') === 'naver';
assert.deepEqual(data.reviews.filter(naver), before.reviews.filter(naver)); assert.deepEqual(data.drafts, before.drafts);
const coupang = data.reviews.filter(r => r.platform === 'coupang');
assert.equal(coupang.length, data.syncs.coupang.total); assert.ok(coupang.every(r => r.readOnly && !r.hasReply && (r.author.endsWith('***') || r.author === '구매자')));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base); await page.waitForFunction(total => document.querySelector('#stat-total')?.textContent === String(total), data.reviews.length);
  await page.locator('.platform-tabs [data-platform="coupang"]').click();
  assert.equal(await page.locator('.review-card').count(), coupang.length);
  assert.equal(await page.locator('#reply-editor, #generate-button, #prepare-publish').count(), 0);
  if (coupang.length) await page.getByText('쿠팡 리뷰는 확인만 할 수 있어요.', { exact: true }).waitFor();
  await page.screenshot({ path: '.local/coupang-desktop-qa.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '.local/coupang-mobile-qa.png', fullPage: true });
  await page.locator('.platform-tabs [data-platform="naver"]').click(); assert.equal(await page.locator('.review-card').count(), data.reviews.filter(naver).length);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ total: data.reviews.length, naver: data.reviews.filter(naver).length, coupang: coupang.length, from: data.syncs.coupang.from, to: data.syncs.coupang.to, naverDraftsPreserved: true, coupangReadOnly: true, mobileOverflow: false }));
} finally { await browser.close(); }
