import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9337');
try {
  const context = browser.contexts()[0];
  const provider = process.argv[2] || 'baemin';
  const url = process.argv[3];
  let page = context.pages().find(p => url ? p.url() === url : p.url().includes(provider === 'baemin' ? 'self.baemin.com' : 'store.coupangeats.com'));
  if (!page) page = await context.newPage();
  const responses = [];
  page.on('response', async response => {
    if (!/review/i.test(response.url()) || !/json/i.test(response.headers()['content-type'] || '')) return;
    try { responses.push({ url: response.url(), method: response.request().method(), status: response.status(), data: await response.json() }); } catch {}
  });
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  const dom = await page.evaluate(() => ({ text: document.body.innerText, controls: [...document.querySelectorAll('button,input,select,textarea,a')].map(e => ({ tag: e.tagName, text: e.innerText, name: e.getAttribute('name'), type: e.getAttribute('type'), placeholder: e.getAttribute('placeholder'), href: e.getAttribute('href'), className: e.className, ariaLabel: e.getAttribute('aria-label') })) }));
  await writeFile(`.local/${provider}-inspection.json`, JSON.stringify({ url: page.url(), dom, responses }, null, 2));
  console.log(JSON.stringify({ url: page.url(), text: dom.text.slice(0,12500), controls: dom.controls.filter(e => e.tag !== 'A' || /리뷰|매장|가게/.test(e.text)), responses: responses.map(r => ({ url: r.url, method: r.method, status: r.status, keys: Object.keys(r.data || {}) })) }));
} finally { await browser.close(); }
