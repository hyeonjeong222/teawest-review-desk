import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4317');
  await page.locator('.review-card').first().waitFor();
  await page.locator('.nav-item[data-filter="replied"]').click();
  await page.locator('[data-review="5095090701"]').click();
  await page.locator('.posted-reply').waitFor();
  console.log(JSON.stringify({ completed: await page.locator('#nav-replied').innerText(), drafts: await page.locator('#nav-draft').innerText(), postedReplyVisible: await page.locator('.posted-reply').isVisible(), registerButtonAbsent: await page.locator('#prepare-publish').count() === 0, filteredRows: await page.locator('.review-card').count(), errors }));
  await page.screenshot({ path: '.local/reconciled-replies-qa.png', fullPage: true });
} finally { await browser.close(); }
