import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';

// UI fixtures own their static server and never depend on a running seller connection.
let uiServer, appUrl;
before(async () => {
  uiServer = http.createServer(async (req, res) => {
    const files = { '/': 'index.html', '/app.js': 'app.js', '/platforms.js': 'platforms.js', '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg' };
    const name = files[new URL(req.url, 'http://localhost').pathname];
    if (!name) { res.writeHead(404).end(); return; }
    const content = await readFile(new URL(`../public/${name}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' }); res.end(content);
  });
  uiServer.listen(0, '127.0.0.1'); await once(uiServer, 'listening'); appUrl = `http://127.0.0.1:${uiServer.address().port}`;
});
after(async () => { uiServer.closeAllConnections(); await new Promise(resolve => uiServer.close(resolve)); });

test('one shared period refreshes every top store count, survives switching tabs, and never labels stale results as current', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const channels = ['naver','coupang','ably','baemin-teawest','baemin-besti','coupangeats-teawest','coupangeats-besti'];
  const rows = channels.flatMap(platform => ['2026.11.10','2026.06.10','2026.01.10'].map((date,i) => ({ id: `${platform}-${i}`, platform, product: '상품', content: '기간별 후기', author: '고객', rating: 5, date, hasReply: false })));
  const metadata = (period, sequence) => Object.fromEntries(channels.map(p => [p,{period:p.startsWith('baemin-')&&period==='1y'?'6m':period,from:period==='1m'?'2026-10-16':'2025-11-16',to:'2026-11-15',lastSync:sequence}]));
  let data = { reviews: rows, drafts: {}, reviewPeriod:'1y', syncs: metadata('1y','before') }, finish, partialFailure = false;
  const hold = new Promise(resolve => { finish = resolve; });
  await page.route('**/api/**', async route => {
    const req=route.request(), url=new URL(req.url()); let result;
    if(url.pathname==='/api/session') result={csrf:'test',settings:{brand:'테스트'},aiConfigured:false};
    else if(url.pathname==='/api/status') result={connected:true,aiConfigured:false};
    else if(url.pathname==='/api/reviews') result=data;
    else if(url.pathname==='/api/sync') {
      const query=req.postDataJSON(); requests.push(query); assert.equal(query.platform,'all');
      if(requests.length===1) await hold;
      const old=data, reviewPeriod=query.period;
      const reviews=rows.filter(r=>reviewPeriod==='1m'?r.date>'2026.10.15':r.platform.startsWith('baemin-')?r.date>'2026.05.15':true);
      data={...data,reviews,reviewPeriod,syncs:metadata(reviewPeriod,String(requests.length))};
      const warnings=[];
      if(partialFailure){const p='coupangeats-besti';data.syncs[p]=old.syncs[p];data.reviews=[...data.reviews.filter(r=>r.platform!==p),...old.reviews.filter(r=>r.platform===p)];warnings.push({platform:p,message:'테스트 조회 실패'});}
      result={...data,warnings};
    } else assert.fail(`Unexpected request: ${url.pathname}`);
    await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto(appUrl); await page.waitForFunction(()=>document.querySelector('#period').value==='1y');
  await page.locator('#period').selectOption('1m');
  await page.waitForFunction(()=>document.querySelector('#period').disabled);
  for(const p of channels) assert.equal(await page.locator(`#platform-${p}`).textContent(),'조회 중');
  // One provider can finish while the others are still fetching.
  data={...data,reviews:data.reviews.filter(r=>r.platform!=='baemin-teawest'||r.date>'2026.10.15'),syncs:{...data.syncs,'baemin-teawest':metadata('1m','partial')['baemin-teawest']}};
  await page.waitForFunction(()=>document.querySelector('#platform-baemin-teawest').textContent==='1',{}, {timeout:9000});
  assert.equal(await page.locator('#platform-coupangeats-teawest').textContent(),'조회 중');
  finish(); await page.waitForFunction(()=>!document.querySelector('#period').disabled);
  for(const p of channels) assert.equal(await page.locator(`#platform-${p}`).textContent(),'1');
  await page.locator('.platform-tabs [data-platform="coupangeats-teawest"]').click();
  assert.equal(await page.locator('#period').inputValue(),'1m'); assert.equal(await page.locator('#stat-total').textContent(),'1');
  await page.locator('#period').selectOption('1y'); await page.waitForFunction(()=>!document.querySelector('#period').disabled);
  assert.equal(await page.locator('#platform-coupangeats-teawest').textContent(),'3');
  assert.equal(await page.locator('#platform-baemin-teawest').textContent(),'2');
  assert.match(await page.locator('.platform-tabs [data-platform="baemin-teawest"]').textContent(),/최대 6개월/);
  await page.locator('.platform-tabs [data-platform="baemin-besti"]').click(); assert.equal(await page.locator('#period').inputValue(),'1y');
  assert.equal(await page.locator('#stat-total').textContent(),'2');
  partialFailure=true;
  await page.locator('#period').selectOption('1m'); await page.waitForFunction(()=>!document.querySelector('#period').disabled);
  assert.equal(await page.locator('#platform-baemin-besti').textContent(),'1'); assert.equal(await page.locator('#platform-coupangeats-besti').textContent(),'조회 실패');
  await page.locator('.platform-tabs [data-platform="coupangeats-besti"]').click(); assert.match(await page.locator('#period-status').textContent(),/조회 실패.*최근 1년/);
  await page.reload(); await page.waitForFunction(()=>document.querySelector('#period').value==='1m');
  assert.equal(await page.locator('#platform-coupangeats-besti').textContent(),'조회 필요');
  assert.deepEqual(requests.map(r=>r.period),['1m','1y','1m']); assert.deepEqual(errors,[]);
});

test('connection settings align across five providers and support password-only updates and delivery re-login', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const changes = [], opened = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const auth = method => ({ configured: true, enabled: true, method, phase: 'connected' });
  const deliveryAuth = { baemin: { configured: false, enabled: false }, coupangeats: { configured: false, enabled: false } };
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: { brand: '테스트' }, aiConfigured: false };
    else if (url.pathname === '/api/reviews') result = { reviews: [], drafts: {} };
    else if (url.pathname === '/api/status') result = { connected: true, autoLogin: auth('naver'), deliveryAutoLogin: deliveryAuth, platforms: { naver: { connected: true }, coupang: { connected: true, autoLogin: auth('coupang') }, ably: { connected: true, autoLogin: auth('ably') } } };
    else if (/^\/api\/auth(?:\/coupang|\/ably)?\/settings$/.test(url.pathname)) { changes.push({ route: url.pathname, ...req.postDataJSON() }); result = auth(req.postDataJSON().method); }
    else if (url.pathname === '/api/browser/open') { opened.push(req.postDataJSON().platform); result = { connected: false }; }
    else if (/^\/api\/auth\/(baemin|coupangeats)\/(settings|open|forget)$/.test(url.pathname)) {
      const [, , , provider, action] = url.pathname.split('/');
      if (action === 'settings') { changes.push({ route: url.pathname, ...req.postDataJSON() }); deliveryAuth[provider] = { ...auth(provider), phase: 'needs_verification', blocked: 'verification' }; }
      if (action === 'open') { opened.push(provider); deliveryAuth[provider] = auth(provider); }
      if (action === 'forget') deliveryAuth[provider] = { configured: false, enabled: false };
      result = deliveryAuth[provider];
    }
    else assert.fail(`Unexpected request ${url.pathname}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#auth-open').waitFor();
  const boxes = await page.locator('.connection-setting-button').evaluateAll(buttons => buttons.map(b => { const r = b.getBoundingClientRect(); return { top: r.top, width: r.width, height: r.height }; }));
  assert.equal(boxes.length, 5); for (const box of boxes) { assert.equal(box.top, boxes[0].top); assert.ok(Math.abs(box.width - boxes[0].width) < 1); assert.equal(box.height, boxes[0].height); }
  for (const prefix of ['auth', 'coupang-auth', 'ably-auth']) {
    await page.locator(`#${prefix}-open`).click(); await page.locator(`#${prefix}-dialog[open]`).waitFor();
    assert.equal(await page.locator(`#${prefix}-username`).inputValue(), ''); assert.equal(await page.locator(`#${prefix}-password`).inputValue(), '');
    await page.locator(`#${prefix}-password`).fill('synthetic-updated-password');
    await page.locator(`#${prefix}-form button[type=submit]`).click(); await page.locator(`#${prefix}-dialog[open]`).waitFor({ state: 'hidden' });
    assert.equal(changes.at(-1).username, ''); assert.equal(changes.at(-1).password, 'synthetic-updated-password');
    assert.equal(await page.locator(`#${prefix}-password`).inputValue(), '');
  }
  assert.deepEqual(changes.map(c => c.route), ['/api/auth/settings', '/api/auth/coupang/settings', '/api/auth/ably/settings']);
  for (const [button, provider] of [['baemin-auth-open', 'baemin'], ['eats-auth-open', 'coupangeats']]) {
    await page.locator(`#${button}`).click(); await page.locator('#delivery-settings-dialog[open]').waitFor();
    assert.match(await page.locator('.password-update-guide').innerText(), /새 비밀번호/);
    await page.locator('#delivery-settings-store').selectOption(`${provider}-besti`);
    await page.locator('#delivery-auth-username').fill(`${provider}-synthetic-account`); await page.locator('#delivery-auth-password').fill('synthetic-first-password');
    await page.locator('#delivery-auth-save').click(); await page.locator('#delivery-settings-dialog[open]').waitFor({ state: 'hidden' }); await page.waitForFunction(() => !document.querySelector('#delivery-auth-save').disabled);
    assert.equal(changes.at(-1).enabled, true); assert.equal(changes.at(-1).method, provider); assert.equal(await page.locator('#delivery-auth-password').inputValue(), '');
    await page.locator(`#${button}`).click(); await page.locator('#delivery-settings-dialog[open]').waitFor();
    assert.match(await page.locator('#delivery-settings-status').innerText(), /추가 인증/); assert.equal(await page.locator('#delivery-auth-username').inputValue(), '');
    await page.locator('#delivery-settings-browser').click(); await page.waitForFunction(() => !document.querySelector('#delivery-settings-browser').disabled);
    assert.equal(opened.at(-1), provider);
    await page.locator('#delivery-auth-password').fill('synthetic-next-password'); await page.locator('#delivery-auth-save').click(); await page.locator('#delivery-settings-dialog[open]').waitFor({ state: 'hidden' }); await page.waitForFunction(() => !document.querySelector('#delivery-auth-save').disabled);
    assert.equal(changes.at(-1).username, ''); assert.equal(changes.at(-1).password, 'synthetic-next-password');
    await page.reload(); await page.locator(`#${button}`).click(); await page.locator('#delivery-settings-dialog[open]').waitFor(); assert.equal(await page.locator('#delivery-auth-password').inputValue(), ''); assert.equal(await page.locator('#delivery-auth-enabled').isChecked(), true);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#delivery-auth-forget').click(); await page.waitForFunction(() => document.querySelector('#delivery-auth-forget').disabled); assert.equal(await page.locator('#delivery-auth-enabled').isChecked(), false);
    await page.locator('[data-close="delivery-settings-dialog"]').click();
  }
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
});

test('browser: background reviews update without reload, preserve active edits and selection, and persist auto-sync controls', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], settings = [];
  page.on('pageerror', error => errors.push(error.message));
  const naver = { id: '1', platform: 'naver', product: '상품', content: '기존 후기', author: 'n***', rating: 5, date: '2026.11.15', hasReply: false };
  const makeReadOnly = (platform, id) => ({ ...naver, platform, id: `${platform}-${id}`, readOnly: true, rating: platform === 'ably' ? null : 5, satisfaction: true });
  const reviews = [naver, makeReadOnly('coupang', 1), makeReadOnly('ably', 1)]; let drafts = {}, polls = 0;
  let autoSync = { enabled: true, intervalMinutes: 10, platforms: { naver: { phase: 'waiting', lastSuccessAt: new Date().toISOString(), nextRunAt: new Date(Date.now() + 600000).toISOString() }, coupang: { phase: 'login_required', error: '추가 인증을 완료해 주세요.' }, ably: { phase: 'syncing' } } };
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: { brand: '테스트' }, aiConfigured: true, autoSync };
    else if (url.pathname === '/api/status') result = { connected: true, aiConfigured: true };
    else if (url.pathname === '/api/reviews') { polls++; result = { reviews, drafts, autoSync, syncs: Object.fromEntries(['naver','coupang','ably'].map(p => [p,{period:'3m'}])) }; }
    else if (url.pathname.endsWith('/draft')) { drafts[req.url().split('/').at(-2)] = { text: req.postDataJSON().text }; result = { saved: true }; }
    else if (url.pathname === '/api/auto-sync/settings') { const data = req.postDataJSON(); settings.push(data); autoSync = { ...autoSync, ...data }; result = autoSync; }
    else assert.fail(`Unexpected request; no generation, sync, or publish allowed: ${url.pathname}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#reply-editor').waitFor();
  await page.locator('.platform-tabs [data-platform="naver"]').click();
  await page.locator('#reply-editor').fill('자동으로 새 리뷰가 와도 유지할 초안입니다.');
  await page.waitForFunction(() => document.querySelector('#draft-status')?.textContent === '초안 저장됨');
  await page.locator('#reply-editor').evaluate(e => e.setSelectionRange(4, 4));
  const beforePolls = polls;
  reviews.unshift({ ...naver, id: '2', content: '새 네이버 리뷰' }, makeReadOnly('coupang', 2), makeReadOnly('ably', 2));
  naver.content = '고객이 수정한 기존 후기';
  await page.waitForFunction(() => ['naver', 'coupang', 'ably'].every(p => document.querySelector(`#platform-${p}`)?.textContent === '2'), {}, { timeout: 9000 });
  assert.ok(polls > beforePolls); assert.equal(await page.locator('.review-card').count(), 2);
  assert.equal(await page.locator('[data-review="1"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#reply-editor').inputValue(), '자동으로 새 리뷰가 와도 유지할 초안입니다.');
  assert.equal(await page.locator('.original-review').innerText(), naver.content);
  assert.equal(await page.locator('#reply-editor').evaluate(e => document.activeElement === e && e.selectionStart === 4), true);
  assert.match(await page.locator('#live-update-message').innerText(), /3개/); assert.match(await page.locator('#auto-sync-platforms').innerText(), /추가 인증/);
  await page.locator('#auto-sync-interval').selectOption('30'); await page.waitForFunction(() => !document.querySelector('#auto-sync-interval').disabled);
  await page.locator('#auto-sync-enabled').uncheck(); await page.waitForFunction(() => !document.querySelector('#auto-sync-enabled').disabled);
  assert.deepEqual(settings, [{ enabled: true, intervalMinutes: 30 }, { enabled: false, intervalMinutes: 30 }]);
  await page.reload(); await page.locator('#reply-editor').waitFor(); assert.equal(await page.locator('#auto-sync-enabled').isChecked(), false); assert.equal(await page.locator('#auto-sync-interval').inputValue(), '30');
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});

test('browser: Ably tab shows satisfaction without stars, filters independently, syncs and recovers login with cached data', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], calls = []; page.on('pageerror', e => errors.push(e.message));
  const naver = { id: '123', product: '네이버 상품', content: '네이버 후기', rating: 5, author: 'n***', date: '2026.11.15', hasReply: false };
  const coupang = { ...naver, id: 'coupang-123', platform: 'coupang', readOnly: true, rating: 1 };
  const ably = { ...naver, id: 'ably-123', sourceId: '123', platform: 'ably', product: '에이블리 상품', productUrl: null, readOnly: true, author: '구매자', rating: null, satisfaction: false, content: '<script>bad()</script> 에이블리 후기' };
  const reviews = [naver, coupang, ably, { ...ably, id: 'ably-124', satisfaction: true }];
  let connected = false;
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: { brand: '테스트' }, aiConfigured: true };
    else if (url.pathname === '/api/status') result = { connected: true, aiConfigured: true, platforms: { naver: { connected: true }, coupang: { connected: true }, ably: { connected } } };
    else if (url.pathname === '/api/reviews' || url.pathname === '/api/sync') {
      if (req.method() === 'POST') calls.push(req.postDataJSON());
      result = { reviews, drafts: { '123': { text: '보존할 초안입니다.' } }, syncs: { ably: { period: '6m' } }, warnings: [] };
    } else if (url.pathname === '/api/browser/open') { calls.push(req.postDataJSON()); connected = true; result = { connected }; }
    else assert.fail(`Unexpected route ${url.pathname}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#reply-editor').waitFor();
  assert.equal(await page.locator('#stat-rating').innerText(), '5.0');
  await page.locator('#connect-ably-sidebar').click();
  assert.equal(await page.locator('#platform-heading').innerText(), '에이블리 리뷰'); assert.equal(await page.locator('.review-card').count(), 2);
  assert.equal(await page.locator('#stat-rating-label').innerText(), '만족 비율'); assert.equal(await page.locator('#stat-rating').innerText(), '50');
  assert.equal(await page.locator('.review-card .stars, #detail-panel .stars, #reply-editor, #generate-button, #prepare-publish').count(), 0);
  assert.equal(await page.locator('.product-info a').count(), 0); assert.equal(await page.locator('.product-name').innerText(), '에이블리 상품');
  assert.equal(await page.locator('.original-review').innerText(), ably.content); assert.equal(await page.locator('#detail-panel script').count(), 0);
  assert.equal(await page.locator('#ably-connection-banner').isVisible(), true); assert.equal(await page.locator('#connection-banner').isVisible(), false);
  await page.locator('#rating-filter').selectOption('unsatisfied'); assert.equal(await page.locator('.review-card').count(), 1);
  await page.locator('#rating-filter').selectOption('satisfied'); assert.equal(await page.locator('.review-card').count(), 1);
  await page.locator('#ably-connect-button').click(); await page.locator('#ably-connection-banner').waitFor({ state: 'hidden' }); assert.deepEqual(calls[0], { platform: 'ably' });
  await page.locator('#sync-button').click(); await page.waitForFunction(() => !document.querySelector('#sync-button').disabled); assert.deepEqual(calls[1], { platform: 'ably', period: '6m' });
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.platform-tabs [data-platform="naver"]').click(); assert.equal(await page.locator('#rating-filter').inputValue(), 'all'); assert.equal(await page.locator('#reply-editor').inputValue(), '보존할 초안입니다.');
  await page.locator('.platform-tabs [data-platform="coupang"]').click(); assert.equal(await page.locator('.review-card').count(), 1);
  await page.locator('.platform-tabs [data-platform="ably"]').click(); assert.equal(await page.locator('.review-card').count(), 2); assert.deepEqual(errors, []);
});

test('browser: Ably automatic login saves once, clears secrets, supports MFA recovery and leaves Naver settings alone', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let auth = { configured: false, enabled: false }, connected = false, saved, opened = [];
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: { brand: '테스트' }, aiConfigured: false };
    else if (url.pathname === '/api/reviews') result = { reviews: [], drafts: {} };
    else if (url.pathname === '/api/status') result = { connected: true, aiConfigured: false, autoLogin: { configured: true, enabled: true, method: 'naver' }, platforms: { naver: { connected: true }, ably: { connected, autoLogin: auth } } };
    else if (url.pathname === '/api/auth/ably/settings') { saved = req.postDataJSON(); auth = { configured: true, enabled: saved.enabled, method: 'ably', phase: 'needs_verification', blocked: 'verification' }; result = auth; }
    else if (url.pathname === '/api/browser/open') { opened.push(req.postDataJSON().platform); connected = true; auth = { ...auth, phase: 'connected', blocked: null }; result = { connected }; }
    else if (url.pathname === '/api/auth/ably/forget') { auth = { configured: false, enabled: false }; result = auth; }
    else assert.fail(`Unexpected request ${url.pathname}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#ably-auth-open').click(); await page.locator('#ably-auth-dialog[open]').waitFor();
  await page.locator('#ably-auth-username').fill('synthetic-user'); await page.locator('#ably-auth-password').fill('synthetic-password');
  await page.locator('#ably-auth-form button[type=submit]').click(); await page.locator('#ably-auth-dialog[open]').waitFor({ state: 'hidden' });
  assert.deepEqual(saved, { enabled: true, method: 'ably', username: 'synthetic-user', password: 'synthetic-password' });
  assert.equal(await page.locator('#ably-auth-password').inputValue(), '');
  await page.reload(); await page.locator('.platform-tabs [data-platform="ably"]').click(); await page.getByText('에이블리 추가 인증이 필요합니다.', { exact: false }).first().waitFor();
  await page.locator('#ably-auth-open').click(); assert.equal(await page.locator('#ably-auth-username').inputValue(), ''); assert.equal(await page.locator('#ably-auth-password').inputValue(), '');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#ably-auth-browser').click(); await page.waitForFunction(() => document.querySelector('#ably-auth-state').textContent.includes('에이블리에 연결되어 있습니다.'));
  assert.deepEqual(opened, ['ably']);
  await page.locator('#ably-auth-forget').click(); await page.waitForFunction(() => document.querySelector('#ably-auth-forget').disabled);
  assert.equal(await page.locator('#ably-auth-enabled').isChecked(), false);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('synthetic-password')), false);
  await page.getByRole('button', { name: '에이블리 설정 닫기', exact: true }).click(); await page.locator('#auth-open').click(); await page.locator('#auth-dialog[open]').waitFor();
  assert.equal(await page.locator('#auth-enabled').isChecked(), true); assert.equal(await page.locator('#auth-password').inputValue(), ''); assert.deepEqual(errors, []);
});

test('browser: Coupang automatic login saves once, clears secrets, supports MFA recovery and leaves Naver settings alone', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let auth = { configured: false, enabled: false }, connected = false, saved, opened = [];
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: { brand: '테스트' }, aiConfigured: false };
    else if (url.pathname === '/api/reviews') result = { reviews: [], drafts: {} };
    else if (url.pathname === '/api/status') result = { connected: true, aiConfigured: false, autoLogin: { configured: true, enabled: true, method: 'naver' }, platforms: { naver: { connected: true }, coupang: { connected, autoLogin: auth } } };
    else if (url.pathname === '/api/auth/coupang/settings') { saved = req.postDataJSON(); auth = { configured: true, enabled: saved.enabled, method: 'coupang', phase: 'needs_verification', blocked: 'verification' }; result = auth; }
    else if (url.pathname === '/api/browser/open') { opened.push(req.postDataJSON().platform); connected = true; auth = { ...auth, phase: 'connected', blocked: null }; result = { connected }; }
    else if (url.pathname === '/api/auth/coupang/forget') { auth = { configured: false, enabled: false }; result = auth; }
    else assert.fail(`Unexpected request ${url.pathname}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#coupang-auth-open').click(); await page.locator('#coupang-auth-dialog[open]').waitFor();
  await page.locator('#coupang-auth-username').fill('synthetic-user'); await page.locator('#coupang-auth-password').fill('synthetic-password');
  await page.locator('#coupang-auth-form button[type=submit]').click(); await page.locator('#coupang-auth-dialog[open]').waitFor({ state: 'hidden' });
  assert.deepEqual(saved, { enabled: true, method: 'coupang', username: 'synthetic-user', password: 'synthetic-password' });
  assert.equal(await page.locator('#coupang-auth-password').inputValue(), '');
  await page.reload(); await page.locator('.platform-tabs [data-platform="coupang"]').click(); await page.getByText('쿠팡 추가 인증이 필요합니다.', { exact: false }).first().waitFor();
  await page.locator('#coupang-auth-open').click(); assert.equal(await page.locator('#coupang-auth-username').inputValue(), ''); assert.equal(await page.locator('#coupang-auth-password').inputValue(), '');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#coupang-auth-browser').click(); await page.waitForFunction(() => document.querySelector('#coupang-auth-state').textContent.includes('쿠팡에 연결되어 있습니다.'));
  assert.deepEqual(opened, ['coupang']);
  await page.locator('#coupang-auth-forget').click(); await page.waitForFunction(() => document.querySelector('#coupang-auth-forget').disabled);
  assert.equal(await page.locator('#coupang-auth-enabled').isChecked(), false);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('synthetic-password')), false);
  await page.getByRole('button', { name: '쿠팡 설정 닫기', exact: true }).click(); await page.locator('#auth-open').click(); await page.locator('#auth-dialog[open]').waitFor();
  assert.equal(await page.locator('#auth-enabled').isChecked(), true); assert.equal(await page.locator('#auth-password').inputValue(), ''); assert.deepEqual(errors, []);
});

test('browser: mixed-platform filters, read-only Coupang detail, Naver-only reply metrics and shared-period refresh', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const naver = { id: '123', product: '네이버 상품', content: '맛있어요', rating: 5, author: 'n***', date: '2026.11.15', hasReply: false, productUrl: 'https://smartstore.naver.com/main/products/123' };
  const reviews = [naver, { ...naver, id: '124', hasReply: true, reply: '감사합니다.' }, { ...naver, id: 'coupang-123', sourceId: '123', platform: 'coupang', readOnly: true, product: '쿠팡 상품', content: '<script>alert(1)</script> 쿠팡 리뷰', rating: 1, productUrl: 'https://www.coupang.com/vp/products/123' }];
  const syncs = { naver: { period: '6m' }, coupang: { period: '3m' } }, refreshes = [], opens = [];
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: { brand: '테스트' }, aiConfigured: true };
    else if (url.pathname === '/api/status') result = { connected: true, aiConfigured: true, platforms: { naver: { connected: true }, coupang: { connected: true } } };
    else if (url.pathname === '/api/reviews') result = { reviews, drafts: { '123': { text: '보존해야 할 네이버 초안입니다.' } }, syncs };
    else if (url.pathname === '/api/sync') { refreshes.push(req.postDataJSON()); result = { reviews, drafts: { '123': { text: '보존해야 할 네이버 초안입니다.' } }, syncs, warnings: [] }; }
    else if (url.pathname === '/api/browser/open') { opens.push(req.postDataJSON().platform); result = { connected: true }; }
    else assert.fail(`Unexpected request ${url.pathname}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#reply-editor').waitFor();
  assert.equal(await page.locator('#stat-total').innerText(), '2'); assert.equal(await page.locator('#stat-rate').innerText(), '50'); assert.equal(await page.locator('#stat-pending').innerText(), '1');
  await page.locator('.filter-tabs [data-filter="pending"]').click(); assert.equal(await page.locator('.review-card').count(), 1);
  await page.locator('#connect-coupang-sidebar').click();
  assert.deepEqual(opens, []); assert.equal(await page.locator('#connect-coupang-sidebar').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.platform-tabs [data-platform="coupang"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.review-card').count(), 1); assert.equal(await page.locator('#period').inputValue(), '6m');
  assert.equal(await page.locator('#reply-editor, #generate-button, #prepare-publish, #reply-tone').count(), 0);
  assert.equal(await page.locator('.filter-tabs').isVisible(), false); assert.equal(await page.locator('#stat-rate').innerText(), '—');
  assert.equal(await page.locator('[data-reply-stat]:visible').count(), 0);
  assert.equal(await page.locator('.original-review').innerText(), reviews[2].content); assert.equal(await page.locator('#detail-panel script').count(), 0);
  await page.locator('#rating-filter').selectOption('5'); assert.equal(await page.locator('.review-card').count(), 0); await page.locator('#rating-filter').selectOption('all');
  await page.locator('#search').fill('없는 상품'); assert.equal(await page.locator('.review-card').count(), 0); await page.locator('#search').fill('');
  await page.locator('#connect-sidebar').click(); assert.deepEqual(opens, []);
  assert.equal(await page.locator('#platform-heading').innerText(), '네이버 리뷰'); assert.equal(await page.locator('.platform-badge.coupang').count(), 0);
  assert.equal(await page.locator('[data-reply-stat]:visible').count(), 2); assert.equal(await page.locator('#reply-editor').inputValue(), '보존해야 할 네이버 초안입니다.');
  await page.locator('#search').fill('네이버 상품'); await page.locator('#rating-filter').selectOption('5');
  await page.locator('.platform-tabs [data-platform="coupang"]').click(); assert.equal(await page.locator('.review-card').count(), 1);
  assert.equal(await page.locator('#search').inputValue(), ''); assert.equal(await page.locator('#rating-filter').inputValue(), 'all');
  await page.locator('#sync-button').click(); await page.waitForFunction(() => !document.querySelector('#sync-button').disabled); assert.deepEqual(refreshes, [{ period: '6m', platform: 'all' }]);
  await page.locator('#coupang-detail-open').click(); await page.waitForResponse(r => new URL(r.url()).pathname === '/api/status'); assert.deepEqual(opens, ['coupang']);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.platform-tabs [data-platform="naver"]').click(); assert.equal(await page.locator('.review-card').count(), 2); assert.equal(await page.locator('#period').inputValue(), '6m');
  assert.equal(await page.locator('#reply-editor').inputValue(), '보존해야 할 네이버 초안입니다.');
  assert.equal(await page.locator('[data-platform="all"], #nav-all').count(), 0); assert.deepEqual(errors, []);
});

test('browser: AI only drafts, edits survive reload, and final human click publishes exactly the edited text', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const review = { id: '1111111111', productId: '123', product: '테스트용 쿠키도우', content: '<script>alert(1)</script> 식감이 좋아요.', rating: 5, store: '테스트 스토어', author: 'test****', date: '2026.11.15. 10:00', media: [], hasReply: false, fingerprint: 'test-fingerprint', productUrl: 'https://smartstore.naver.com/main/products/123#REVIEW' };
  let drafts = {}, published = [], prepared, syncs = 0; const tones = [];
  const secondReview = { ...review, id: '2222222222', product: '다른 상품', content: '두 번째 후기입니다.' };
  // Every API call is intercepted: this test cannot reach a real publishing endpoint.
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), data = req.method() === 'POST' ? req.postDataJSON() : {};
    let result = {}, status = 200;
    if (url.pathname === '/api/session') result = { csrf: 'test-only', aiConfigured: true, settings: { brand: '테스트 스토어', model: 'gpt-5-mini', tone: '따뜻하고 정중하게' } };
    else if (url.pathname === '/api/status') result = { connected: true, aiConfigured: true };
    else if (url.pathname === '/api/reviews' || url.pathname === '/api/sync') { if (url.pathname === '/api/sync') syncs++; result = { reviews: [review, secondReview], drafts, lastSync: new Date().toISOString(), sync: { period: '3m' } }; }
    else if (url.pathname.endsWith('/suggest')) { tones.push(data.tone); result = { text: data.tone ? `${data.tone} · 새 추천 답글입니다.` : '식감을 즐겨 주셔서 감사합니다. 달콤한 하루 보내세요!' }; }
    else if (url.pathname.endsWith('/draft')) { drafts[review.id] = { text: data.text }; result = { saved: true }; }
    else if (url.pathname.endsWith('/prepare')) { prepared = data.text; result = { token: 'mock-human-intent', text: data.text, review }; }
    else if (url.pathname.endsWith('/publish')) { assert.equal(data.token, 'mock-human-intent'); published.push(prepared); review.hasReply = true; review.reply = prepared; result = { success: true, review }; }
    else { status = 500; result = { error: 'Unexpected mock API route' }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('.review-card').first().waitFor();
  assert.equal(await page.locator('.original-review script').count(), 0);
  await page.locator('#generate-button').click(); await page.waitForFunction(() => document.querySelector('#reply-editor')?.value.includes('식감을 즐겨'));
  assert.equal(published.length, 0); assert.equal(tones[0], undefined);
  const edited = '고객님, 식감을 즐겨주셔서 감사합니다. 또 만나 뵙길 바라요!'; await page.locator('#reply-editor').fill(edited);
  await page.waitForFunction(() => document.querySelector('#draft-status')?.textContent === '초안 저장됨');
  await page.locator('#reply-tone').selectOption('친근하고 밝게'); await page.locator('#generate-button').click();
  await page.locator('.suggestion-preview').getByText('친근하고 밝게 · 새 추천 답글입니다.', { exact: true }).waitFor();
  assert.equal(tones.at(-1), '친근하고 밝게'); assert.equal(await page.locator('#reply-editor').inputValue(), edited);
  await page.locator('#reply-tone').selectOption('custom'); await page.locator('#generate-button').click();
  await page.getByText('원하는 말투를 1~200자로 입력해 주세요.', { exact: true }).waitFor(); assert.equal(tones.length, 2);
  const customTone = '이모지 없이 짧고 다정하게'; await page.locator('#reply-tone-custom').fill(customTone);
  await page.locator(`[data-review="${secondReview.id}"]`).click(); assert.equal(await page.locator('#reply-tone').inputValue(), 'default');
  await page.locator(`[data-review="${review.id}"]`).click(); assert.equal(await page.locator('#reply-tone').inputValue(), 'custom'); assert.equal(await page.locator('#reply-tone-custom').inputValue(), customTone);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#generate-button').click(); await page.locator('.suggestion-preview').getByText(`${customTone} · 새 추천 답글입니다.`, { exact: true }).waitFor();
  assert.equal(tones.at(-1), customTone); assert.equal(await page.locator('#reply-editor').inputValue(), edited); assert.equal(published.length, 0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload(); await page.locator('#reply-editor').waitFor(); assert.equal(await page.locator('#reply-editor').inputValue(), edited);
  await page.locator('#prepare-publish').click(); await page.locator('#publish-dialog[open]').waitFor(); assert.equal(await page.locator('#confirm-text').innerText(), edited); assert.equal(published.length, 0);
  await page.locator('#confirm-publish').click(); await page.locator('.posted-reply').waitFor(); assert.deepEqual(published, [edited]); assert.equal(await page.locator('#prepare-publish').count(), 0); assert.equal(await page.locator('#reply-tone').count(), 0);
  assert.deepEqual(errors, []);
});

test('browser: auto-login setup clears secrets and verification recovery never submits a review', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let autoLogin = { enabled: false, configured: false }, connected = true, input;
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: { brand: '테스트' }, aiConfigured: false };
    else if (url.pathname === '/api/reviews') result = { reviews: [], drafts: {} };
    else if (url.pathname === '/api/status') result = { connected, autoLogin, aiConfigured: false };
    else if (url.pathname === '/api/auth/settings') { input = req.postDataJSON(); autoLogin = { enabled: true, configured: true, method: input.method, phase: 'connected' }; result = autoLogin; }
    else if (url.pathname === '/api/browser/open') { connected = true; autoLogin = { ...autoLogin, blocked: null, phase: 'connected' }; result = { connected }; }
    else if (url.pathname === '/api/auth/forget') { autoLogin = { enabled: false, configured: false }; result = autoLogin; }
    else { assert.fail(`Unexpected route ${url.pathname}`); }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#auth-open').click(); await page.locator('#auth-dialog[open]').waitFor();
  await page.locator('#auth-username').fill('test-only-user'); await page.locator('#auth-password').fill('test-only-password');
  await page.locator('#auth-form button[type=submit]').click(); await page.locator('#auth-dialog[open]').waitFor({ state: 'hidden' });
  assert.equal(input.enabled, true); assert.equal(input.password, 'test-only-password'); assert.equal(await page.locator('#auth-password').inputValue(), '');
  connected = false; autoLogin = { ...autoLogin, blocked: 'verification', phase: 'needs_verification' }; await page.reload();
  await page.getByText('추가 인증이 필요합니다.', { exact: false }).first().waitFor();
  assert.equal(await page.locator('#connection-banner').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#connect-button').click(); await page.locator('#connection-banner').waitFor({ state: 'hidden' });
  await page.locator('#auth-open').click(); assert.equal(await page.locator('#auth-password').inputValue(), '');
  await page.locator('#auth-forget').click(); await page.waitForFunction(() => document.querySelector('#auth-forget').disabled);
  assert.equal(await page.locator('#auth-enabled').isChecked(), false);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('test-only-password')), false); assert.deepEqual(errors, []);
});

test('browser: failed publish acknowledgement is reconciled, and another tab updates without losing a draft', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const first = { id: '1111111111', productId: '123', product: '테스트 상품', content: '맛있어요.', rating: 5, store: '테스트', author: 'test****', date: '2026.11.15', media: [], hasReply: false, fingerprint: 'test', productUrl: 'https://smartstore.naver.com/main/products/123' };
  const second = { ...first, id: '2222222222' }; const reviews = [first, second]; let drafts = {}, prepared, sends = 0, details = 0, reviewReads = 0;
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), data = req.method() === 'POST' ? req.postDataJSON() : {};
    let result, status = 200;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: { brand: '테스트' }, aiConfigured: false };
    else if (url.pathname === '/api/status') result = { connected: true, aiConfigured: false };
    else if (url.pathname === '/api/reviews') { reviewReads++; result = { reviews, drafts }; }
    else if (url.pathname.endsWith('/draft')) { const id = url.pathname.split('/')[3]; drafts[id] = { text: data.text }; result = { saved: true }; }
    else if (url.pathname.endsWith('/prepare')) { prepared = data.text; result = { token: 'human-confirmed', text: prepared }; }
    else if (url.pathname.endsWith('/publish')) { sends++; first.hasReply = true; first.reply = prepared; status = 409; result = { code: 'RESULT_UNCERTAIN', error: '결과 확인 실패' }; }
    else if (url.pathname.endsWith('/detail')) { details++; delete drafts[first.id]; result = first; }
    else assert.fail(`Unexpected request ${url.pathname}`);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#reply-editor').fill('내가 확인하고 등록한 답글입니다.');
  await page.locator('#prepare-publish').click(); await page.locator('#confirm-publish').click();
  await page.locator('.posted-reply').waitFor(); assert.equal(sends, 1); assert.equal(details, 1); assert.equal(await page.locator('#stat-rate').innerText(), '50');
  await page.locator(`[data-review="${second.id}"]`).click(); await page.locator('#reply-editor').fill('계속 작성 중인 내 초안입니다.');
  await page.waitForFunction(() => document.querySelector('#draft-status')?.textContent === '초안 저장됨');
  const beforeReads = reviewReads;
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/reviews'), page.evaluate(() => window.dispatchEvent(new Event('focus')))]);
  assert.ok(reviewReads > beforeReads); assert.equal(await page.locator('#reply-editor').inputValue(), '계속 작성 중인 내 초안입니다.');
  second.hasReply = true; second.reply = '다른 탭에서 등록된 최종 답글입니다.'; delete drafts[second.id];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.locator('.posted-reply').getByText(second.reply, { exact: true }).waitFor();
  assert.equal(await page.locator('#stat-rate').innerText(), '100'); assert.equal(await page.locator('#nav-draft').innerText(), '0'); assert.equal(await page.locator('#prepare-publish').count(), 0);
  assert.equal(sends, 1); assert.deepEqual(errors, []);
});

test('browser: saved GPT key is never rehydrated into the input and can be deleted', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); let configured = false, receivedKey, deleted = 0;
  const settings = { brand: '테스트', tone: '따뜻하고 정중하게', model: 'gpt-5-mini' };
  const keyState = () => ({ aiConfigured: configured, aiKey: { saved: configured, storageError: false, source: configured ? 'saved' : 'none' } });
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings, ...keyState() };
    else if (url.pathname === '/api/status') result = { connected: true, ...keyState() };
    else if (url.pathname === '/api/reviews') result = { reviews: [], drafts: {} };
    else if (url.pathname === '/api/settings') { const data = req.postDataJSON(); if (data.disconnectAI) { configured = false; deleted++; } else { receivedKey = data.apiKey; configured = true; } result = { settings, ...keyState() }; }
    else assert.fail(`Unexpected request ${url.pathname}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#ai-chip').click(); await page.locator('#setting-key').fill('sk-test-ui-only');
  await page.locator('#settings-form button[type="submit"]').click(); await page.locator('#settings-dialog[open]').waitFor({ state: 'hidden' });
  assert.equal(receivedKey, 'sk-test-ui-only'); assert.equal(await page.locator('#setting-key').inputValue(), '');
  await page.reload(); await page.locator('#ai-chip').click(); assert.equal(await page.locator('#setting-key').inputValue(), '');
  assert.equal(await page.locator('#settings-ai-state').innerText(), '암호화 저장됨');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#settings-key-forget').click(); await page.getByText('이 앱에 저장된 API 키를 삭제하고 GPT 연결을 해제했습니다.', { exact: true }).waitFor();
  assert.equal(deleted, 1); assert.equal(await page.locator('#ai-status').innerText(), 'GPT 연결하기'); assert.equal(await page.locator('#settings-key-forget').isDisabled(), true);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('sk-test-ui-only')), false);
});
