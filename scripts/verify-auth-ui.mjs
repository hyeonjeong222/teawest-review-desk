import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height }); await page.goto('http://127.0.0.1:4317');
    await page.locator('#auth-open').click(); await page.locator('#auth-dialog[open]').waitFor();
    await page.screenshot({ path: `.local/auth-${name}-qa.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error(`${name} overflow`);
    console.log(JSON.stringify({ name, settingsVisible: await page.locator('#auth-form').isVisible(), overflow }));
  }
  if (errors.length) throw new Error('UI errors');
} finally { await browser.close(); }
