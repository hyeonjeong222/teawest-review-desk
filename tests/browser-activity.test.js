import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { withActiveReviewPage } from '../src/browser-activity.js';
import { BaeminConnector, clickBaeminFilter } from '../src/baemin.js';
import { spawn } from 'node:child_process';
import { mkdtemp, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browserCandidates } from '../src/browser-path.js';
import { cleanupTestDirectory } from './cleanup.js';

test('a hidden review tab renders during a read without switching the foreground tab, and releases focus after success or failure', async t => {
  // Launch exactly as the local app does: attaching must not enable Playwright's
  // own focus emulation, which would hide the production regression.
  const profile = await mkdtemp(path.join(os.tmpdir(), 'review-desk-test-browser-'));
  let executable; for (const candidate of browserCandidates()) { try { await access(candidate); executable = candidate; break; } catch {} }
  assert.ok(executable);
  const endpoint = 'http://127.0.0.1:19387';
  const child = spawn(executable, ['--remote-debugging-port=19387', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-position=-2400,-2400', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let browser;
  t.after(async () => {
    if (browser) { const control = await browser.newBrowserCDPSession(); await control.send('Browser.close').catch(() => {}); await browser.close().catch(() => {}); }
    for (let i = 0; i < 30 && child.exitCode === null; i++) await new Promise(r => setTimeout(r, 100));
    if (child.exitCode === null) child.kill();
    await cleanupTestDirectory(profile);
  });
  for (let i = 0; i < 40; i++) { try { browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 1000 }); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.ok(browser);
  const context = browser.contexts()[0], review = context.pages()[0];
  await review.setContent('<h1>Review fixture</h1>');
  await review.evaluate(() => { window.rendered = 0; function frame() { window.rendered++; requestAnimationFrame(frame); } requestAnimationFrame(frame); });
  const foreground = await context.newPage(); await foreground.setContent('<h1>Other store fixture</h1>'); await foreground.bringToFront();
  assert.equal(await review.evaluate(() => document.visibilityState), 'hidden');
  const before = await review.evaluate(() => window.rendered);
  await withActiveReviewPage(review, async () => {
    assert.equal(await review.evaluate(() => document.visibilityState), 'visible');
    await review.waitForFunction(count => window.rendered > count + 2, before, { timeout: 5000 });
    assert.equal(await foreground.evaluate(() => document.visibilityState), 'visible');
  });
  assert.equal(await review.evaluate(() => document.visibilityState), 'hidden');
  await assert.rejects(withActiveReviewPage(review, async () => { throw new Error('read failed'); }), /read failed/);
  assert.equal(await review.evaluate(() => document.visibilityState), 'hidden');
});

test('Baemin selects a review tab before a login landing tab and filter controls reject ambiguous or disabled targets', async t => {
  const landing = { url: () => 'https://self.baemin.com/' }, reviews = { url: () => 'https://self.baemin.com/shops/123/reviews' };
  const connector = new BaeminConnector({ connect: async () => ({ contexts: () => [{ pages: () => [landing, reviews] }] }) }, 'baemin-teawest');
  assert.equal(await connector.getPage(), reviews);
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<input type="radio" name="period" value="month"><button disabled>적용</button><button>닫기</button><button>닫기</button>');
  await clickBaeminFilter(page.locator('input')); assert.equal(await page.locator('input').isChecked(), true);
  await assert.rejects(clickBaeminFilter(page.getByRole('button', { name: '적용' })));
  await assert.rejects(clickBaeminFilter(page.getByRole('button', { name: '닫기' })));
});
