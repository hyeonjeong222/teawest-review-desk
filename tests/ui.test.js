import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';

// UI fixtures own their static server and never depend on a running seller connection.
let uiServer, appUrl;
async function openConnectionSettings(page) {
  if (await page.locator('#connection-settings-panel').getAttribute('open') === null) await page.locator('#connection-settings-panel > summary').click();
}
before(async () => {
  uiServer = http.createServer(async (req, res) => {
    const files = { '/': 'index.html', '/app.js': 'app.js', '/inquiries.js': 'inquiries.js', '/inquiry-alerts.js': 'inquiry-alerts.js', '/platforms.js': 'platforms.js', '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg' };
    const name = files[new URL(req.url, 'http://localhost').pathname];
    if (!name) { res.writeHead(404).end(); return; }
    const content = await readFile(new URL(`../public/${name}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' }); res.end(content);
  });
  uiServer.listen(0, '127.0.0.1'); await once(uiServer, 'listening'); appUrl = `http://127.0.0.1:${uiServer.address().port}`;
});
after(async () => { uiServer.closeAllConnections(); await new Promise(resolve => uiServer.close(resolve)); });

test('authored drafts are refined by explicit preview on reviews and all inquiry platforms, with stale edits protected', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }), errors = [], requests = [], drafts = new Map();
  page.on('pageerror', e => errors.push(e.message)); let pending;
  const row = { id: '1'.repeat(64), author: '테스트 고객', date: '2026-11-21', store: '테스트 매장', title: '발송 문의', content: '발송은 언제인가요?', product: '테스트 상품', status: 'pending', canReply: true, fingerprint: 'test', replyLimit: 1000, messages: [{ id: '1', role: 'customer', text: '발송은 언제인가요?' }] };
  const review = { id: 'test-review', author: '고객', date: '2026-11-21', product: '테스트 상품', content: '잘 받았습니다.', rating: 5, hasReply: false };
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), data = req.method() === 'POST' ? req.postDataJSON() : {}; let result = {};
    if (url.pathname === '/api/session') result = { csrf: 'test', aiConfigured: true, settings: { tone: '정중하게' } };
    else if (url.pathname === '/api/status') result = { connected: true, aiConfigured: true };
    else if (url.pathname === '/api/reviews') result = { reviews: [review], drafts: {} };
    else if (url.pathname.endsWith('/refine')) { requests.push({ pathname: url.pathname, data }); pending = route; return; }
    else if (url.pathname.endsWith('/draft')) { drafts.set(url.pathname, data.text); result = { saved: true }; }
    else if (url.pathname.startsWith('/api/inquiries/')) {
      const [, , , platform, action] = url.pathname.split('/'), category = platform === 'ably' ? 'goods' : 'customer';
      if (action === 'sync') result = { store: row.store, checkedAt: '2026-11-21T00:00:00Z', items: [{ id: category, count: 1 }] };
      else if (action === 'list') result = { store: row.store, checkedAt: '2026-11-21T00:00:00Z', records: [{ ...row, platform, category, canComplete: platform === 'ably' }] };
      else if (url.pathname.endsWith('/detail')) result = { ...row, platform, category, canComplete: platform === 'ably', draft: drafts.get(url.pathname.replace('/detail', '/draft')) || '' };
      else assert.fail(url.pathname);
    } else assert.fail('No generation, send or completion expected: ' + url.pathname);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  const start = async selector => { const request = page.waitForRequest(r => r.url().endsWith('/refine')); await page.locator(selector).click(); await request; };
  const finish = async (fail = false) => { const route = pending; pending = null; assert.ok(route); await route.fulfill({ status: fail ? 429 : 200, contentType: 'application/json', body: JSON.stringify(fail ? { error: '테스트 한도 오류', code: 'AI_LIMIT' } : { text: '11월 25일에 발송 예정입니다.', fingerprint: row.fingerprint }) }); };
  await page.goto(appUrl); await page.locator('#reply-editor').waitFor();
  for (const platform of ['reviews', 'naver', 'coupang', 'ably']) {
    const isReview = platform === 'reviews', prefix = platform === 'naver' ? '' : platform + '-';
    if (!isReview) {
      await page.locator('#inquiry-workspace-tab').click(); await page.locator(`[data-inquiry-platform="${platform}"]`).click();
      await page.locator(`[data-${platform === 'naver' ? '' : platform + '-'}inquiry-category="${platform === 'ably' ? 'goods' : 'customer'}"]`).click();
      if (platform !== 'ably') await page.locator(`#${platform === 'naver' ? '' : platform + '-'}inquiry-inbox [data-inbox-id]`).click();
    }
    const editor = isReview ? '#reply-editor' : `#${prefix}inbox-reply`, button = isReview ? '#refine-button' : `#${prefix}inbox-refine`, apply = isReview ? '#apply-suggestion' : `#${prefix}inbox-apply-suggestion`;
    const tone = isReview ? '#reply-tone' : `#${prefix}inbox-tone`, custom = isReview ? '#reply-tone-custom' : `#${prefix}inbox-custom-tone`;
    await page.locator(editor).waitFor(); assert.equal(await page.locator(button).isDisabled(), true);
    await page.locator(editor).fill('11월 25일 발송 예정이에요.'); await page.locator(tone).selectOption('custom'); await page.locator(custom).fill('정중하고 간결하게');
    await start(button); assert.equal(requests.at(-1).data.text, '11월 25일 발송 예정이에요.'); assert.equal(requests.at(-1).data.tone, '정중하고 간결하게');
    assert.equal(await page.locator(button).isDisabled(), true); assert.equal(await page.locator(editor).isEnabled(), true);
    await finish(); await page.locator(apply).waitFor(); assert.equal(await page.locator(editor).inputValue(), '11월 25일 발송 예정이에요.');
    assert.equal(await page.locator(apply).innerText(), '다듬은 초안 적용');
    const preview = page.locator(isReview ? '.suggestion-preview' : `#${prefix}inbox-ai .inbox-ai-suggestion`);
    await preview.locator('summary').click(); assert.equal(await preview.locator('.refinement-original p').innerText(), '11월 25일 발송 예정이에요.');
    if (isReview || platform === 'ably') {
      await page.locator(button).scrollIntoViewIfNeeded(); await page.screenshot({ path: `.local/refinement-${platform}-desktop.png` });
      await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator(button).scrollIntoViewIfNeeded(); await page.screenshot({ path: `.local/refinement-${platform}-mobile.png` }); await page.setViewportSize({ width: 1440, height: 1050 });
    }
    await page.locator(apply).click(); assert.equal(await page.locator(editor).inputValue(), '11월 25일에 발송 예정입니다.');
    await start(button); await page.locator(editor).fill('날짜를 수정한 새로운 초안이에요.'); await finish();
    await page.waitForFunction(selector => !document.querySelector(selector)?.disabled, button); assert.equal(await page.locator(apply).count(), 0);
    assert.equal(await page.locator(editor).inputValue(), '날짜를 수정한 새로운 초안이에요.');
    await start(button); await finish(); await page.locator(apply).waitFor(); await page.locator(editor).fill('결과를 본 뒤 다시 수정했습니다.'); assert.equal(await page.locator(apply).count(), 0);
    await start(button); await finish(true); await page.waitForFunction(selector => !document.querySelector(selector)?.disabled, button);
    assert.equal(await page.locator(editor).inputValue(), '결과를 본 뒤 다시 수정했습니다.'); assert.equal(await page.locator(apply).count(), 0);
    await page.waitForFunction(({ selector }) => document.querySelector(selector)?.textContent.includes('초안 저장됨'), { selector: isReview ? '#draft-status' : `#${prefix}inbox-save-status` });
  }
  assert.deepEqual(errors, []); assert.equal(requests.length, 16);
});

test('inquiry alerts stay below workspace tabs, monitor all stores while reviewing and open the first pending conversation', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], calls = [], drafts = new Map();
  await page.clock.install(); page.on('pageerror', e => errors.push(e.message));
  const categories = { naver: ['talktalk', 'customer', 'product', 'center'], coupang: ['center', 'customer'], ably: ['goods', 'order_before_delivery', 'order_after_delivery', 'order_etc', 'etc', 'place', 'affiliate_sponsorship'] };
  let reviewDraft = '', arrived = false, coupangFailed = false;
  const rows = Object.fromEntries(['naver', 'coupang', 'ably'].map((platform, index) => [platform, { id: String(index + 1).repeat(64), category: platform === 'naver' ? 'product' : platform === 'coupang' ? 'customer' : 'order_after_delivery', store: platform + ' 테스트', title: platform + ' 새 문의', author: '고객', content: '배송 상태를 확인하고 싶어요.', date: '2026-11-18', status: 'pending', canReply: true, fingerprint: platform, replyLimit: 1000, messages: [{ id: '1', role: 'customer', text: platform + ' 고객의 질문' }] }]));
  await page.route('**/api/**', async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname, data = req.method() === 'POST' ? req.postDataJSON() : {}; let result = {}, status = 200;
    if (pathname === '/api/session') result = { csrf: 'fixture', settings: {}, capabilities: { inquiryAlerts: true } };
    else if (pathname === '/api/status') result = { connected: true };
    else if (pathname === '/api/reviews') result = { reviews: [{ id: 'review-test', product: '리뷰 상품', content: '구매 후기입니다.', author: '고객', date: '2026-11-18', rating: 5, hasReply: false }], drafts: reviewDraft ? { 'review-test': { text: reviewDraft } } : {} };
    else if (pathname === '/api/reviews/review-test/draft') { reviewDraft = data.text; result = { saved: true }; }
    else if (pathname.startsWith('/api/inquiries/')) {
      const [, , , platform, id, action] = pathname.split('/'), row = rows[platform]; calls.push({ platform, id, action });
      if (id === 'sync') {
        if (platform === 'coupang' && coupangFailed) { status = 409; result = { error: '쿠팡 로그인을 다시 확인해 주세요.', code: 'COUPANG_LOGIN_REQUIRED' }; }
        else result = { store: row.store, checkedAt: new Date().toISOString(), targetDay: platform === 'coupang' ? 30 : undefined, items: categories[platform].map(id => ({ id, count: arrived && row.status === 'pending' && id === row.category ? 1 : 0 })) };
      } else if (id === 'list') result = { store: row.store, checkedAt: new Date().toISOString(), records: [{ ...row, id: '0'.repeat(64), status: 'answered', canReply: false, title: '이전 답변 완료 문의' }, row] };
      else if (action === 'detail') { assert.equal(id, row.id); result = { ...row, draft: drafts.get(platform) || '' }; }
      else if (action === 'draft') { drafts.set(platform, data.text); result = { saved: true }; }
      else if (action === 'prepare') result = { token: 'fixture', text: data.text, inquiry: row };
      else if (action === 'publish') { row.status = 'answered'; row.canReply = false; result = { sent: true, inquiry: row }; }
      else assert.fail(pathname);
    } else assert.fail(pathname);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#inquiry-alert-total').getByText('모두 확인했어요').waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('.workspace-tabs').nextElementSibling.id), 'inquiry-alerts');
  assert.equal(await page.locator('#review-workspace').isVisible(), true);
  await page.locator('#reply-editor').fill('리뷰에 작성 중인 답변');
  arrived = true; await page.clock.fastForward(30000); await page.locator('#inquiry-alert-total').getByText('3건', { exact: true }).waitFor();
  assert.equal(await page.locator('#reply-editor').inputValue(), '리뷰에 작성 중인 답변');
  assert.equal(await page.locator('.inquiry-alert-category').count(), 3);
  await page.locator('#inquiry-alerts').screenshot({ path: '.local/inquiry-alerts-desktop.png' });
  for (const platform of ['naver', 'coupang', 'ably']) {
    await page.locator(`.inquiry-alert-category[data-alert-platform="${platform}"]`).click();
    const prefix = platform === 'naver' ? '' : platform + '-';
    await page.locator(`#${prefix}inbox-detail .inbox-messages`).getByText(platform + ' 고객의 질문', { exact: true }).waitFor();
    assert.equal(await page.locator(`#${prefix}inbox-status`).inputValue(), 'pending');
    assert.equal(await page.locator(`#${prefix}inbox-list [data-inbox-id]`).count(), 1);
    assert.equal(await page.locator('#inquiry-alerts').isVisible(), true);
    await page.locator(`#${prefix}inbox-reply`).fill(platform + ' 작성 중');
  }
  await page.locator('#review-workspace-tab').click(); assert.equal(await page.locator('#reply-editor').inputValue(), '리뷰에 작성 중인 답변');
  coupangFailed = true; await page.locator('#inquiry-alert-refresh').click(); await page.locator('[data-alert-card="coupang"] [data-alert-status]').getByText('연결 확인 필요').waitFor();
  assert.equal(await page.locator('[data-alert-card="coupang"] [data-alert-count]').innerText(), '—');
  assert.equal(await page.locator('#inquiry-alert-total').innerText(), '확인된 문의 2건');
  coupangFailed = false; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.locator('#inquiry-alert-total').getByText('3건', { exact: true }).waitFor();
  await page.locator('.inquiry-alert-category[data-alert-platform="naver"]').click(); await page.locator('#inbox-reply').waitFor();
  assert.equal(await page.locator('#inbox-reply').inputValue(), 'naver 작성 중');
  await page.locator('#inbox-prepare').click(); await page.locator('#inbox-confirm-send').click(); await page.locator('[data-alert-card="naver"] [data-alert-count]').getByText('0', { exact: true }).waitFor();
  assert.equal(await page.locator('#inquiry-alert-total').innerText(), '2건');
  await page.locator('#review-workspace-tab').click(); await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#inquiry-alerts').screenshot({ path: '.local/inquiry-alerts-mobile.png' });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const syncs = calls.filter(c => c.id === 'sync').length; await page.clock.fastForward(30000); assert.equal(calls.filter(c => c.id === 'sync').length, syncs);
  assert.deepEqual(errors, []);
});

test('Naver inquiry refresh updates counts and lists on a timer and focus without replacing the draft editor', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], drafts = new Map();
  await page.clock.install(); page.on('pageerror', e => errors.push(e.message));
  let rows = [], syncs = 0, lists = 0, failList = false;
  const row = (id, title) => ({ id: id.repeat(64), store: '테스트 매장', category: 'product', title, content: title, author: '고객', date: '2026-11-18', status: 'pending', canReply: true, fingerprint: id, replyLimit: 1000, messages: [{ id: '1', role: 'customer', text: title }] });
  const first = row('a', '첫 문의'), second = row('b', '새 상품 문의'), third = row('c', '복귀 후 새 문의');
  await page.route('**/api/**', async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname, data = req.method() === 'POST' ? req.postDataJSON() : {}; let result = {}, status = 200;
    if (pathname === '/api/session') result = { csrf: 'fixture', settings: {}, aiConfigured: false };
    else if (pathname === '/api/reviews') result = { reviews: [], drafts: {} };
    else if (pathname === '/api/status') result = { connected: true };
    else if (pathname === '/api/inquiries/naver/sync') { syncs++; result = { store: first.store, checkedAt: new Date().toISOString(), items: ['talktalk', 'customer', 'product', 'center'].map(id => ({ id, count: id === 'product' ? rows.length : 0 })) }; }
    else if (pathname === '/api/inquiries/naver/list') { lists++; if (failList) { status = 502; result = { error: '테스트 조회 실패' }; } else result = { records: rows, store: first.store, checkedAt: new Date().toISOString() }; }
    else if (pathname.endsWith('/detail')) { const id = pathname.split('/').at(-2); result = { ...rows.find(r => r.id === id), draft: drafts.get(id) || '' }; }
    else if (pathname.endsWith('/draft')) { drafts.set(pathname.split('/').at(-2), data.text); result = { saved: true }; }
    else if (pathname.endsWith('/prepare')) result = { token: 'fixture', inquiry: first, text: data.text };
    else assert.fail('Unexpected action: ' + pathname);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl + '/#inquiries'); await page.locator('[data-inquiry-category="product"]').click(); await page.locator('#inbox-list .empty').waitFor();
  assert.equal(await page.locator('#inquiry-count-product').innerText(), '0');
  rows = [first]; await page.clock.fastForward(30000); await page.locator(`[data-inbox-id="${first.id}"]`).waitFor();
  assert.equal(await page.locator('#inquiry-count-product').innerText(), '1');
  await page.locator(`[data-inbox-id="${first.id}"]`).click(); await page.locator('#inbox-reply').fill('작성 중인 답변은 보존합니다.');
  await page.evaluate(() => { window.savedEditor = document.querySelector('#inbox-reply'); window.savedEditor.setSelectionRange(3, 3); });
  rows = [second, first]; await page.clock.fastForward(30000); await page.locator(`[data-inbox-id="${second.id}"]`).waitFor();
  assert.equal(await page.locator('#inquiry-count-product').innerText(), '2');
  assert.deepEqual(await page.evaluate(() => ({ same: savedEditor === document.querySelector('#inbox-reply'), cursor: savedEditor.selectionStart, focus: document.activeElement === savedEditor, text: savedEditor.value })), { same: true, cursor: 3, focus: true, text: '작성 중인 답변은 보존합니다.' });
  first.fingerprint = 'changed'; first.messages.push({ id: '2', role: 'customer', text: '추가 질문입니다.' }); rows = [third, second, first];
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.locator(`[data-inbox-id="${third.id}"]`).waitFor(); await page.locator('#inbox-live-update').waitFor();
  assert.equal(await page.locator('#inquiry-count-product').innerText(), '3'); assert.equal(await page.locator('#inbox-reply').inputValue(), '작성 중인 답변은 보존합니다.');
  await page.locator('#inbox-load-latest').click(); await page.locator('.inbox-messages').getByText('추가 질문입니다.', { exact: true }).waitFor(); assert.equal(await page.locator('#inbox-reply').inputValue(), '작성 중인 답변은 보존합니다.');
  failList = true; await page.locator('#inquiry-refresh').click(); await page.locator('#inbox-error').getByText('테스트 조회 실패', { exact: false }).waitFor(); assert.equal(await page.locator('[data-inbox-id]').count(), 3);
  failList = false; await page.locator('#inquiry-refresh').click(); await page.locator('#inbox-error').waitFor({ state: 'hidden' });
  await page.locator('#inbox-prepare').click(); await page.locator('#inbox-confirm[open]').waitFor(); const beforeLists = lists;
  await page.clock.fastForward(30000); await page.waitForFunction(() => document.querySelector('.inquiry-summary').getAttribute('aria-busy') === 'false'); assert.equal(lists, beforeLists);
  await page.locator('#inbox-confirm-cancel').click();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const beforeSyncs = syncs; await page.clock.fastForward(30000); assert.equal(syncs, beforeSyncs);
  const refreshRequest = page.waitForRequest(r => r.url().endsWith('/naver/sync'));
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); }); await refreshRequest;
  assert.deepEqual(errors, []);
});

test('inquiry GPT preserves edits and platform drafts, previews replacements and keeps sending manual', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [], drafts = new Map(), pending = new Map(), requests = [];
  page.on('pageerror', e => errors.push(e.message)); let configured = true;
  const common = { id: '9'.repeat(64), title: '반품 포장 문의', content: '포장은 어떻게 하나요?', author: '고객', product: '셔츠', status: 'pending', canReply: true, fingerprint: 'fixture', replyLimit: 1000, messages: [{ id: '1', role: 'seller', text: '회수 방법을 안내드리겠습니다.' }, { id: '2', role: 'customer', text: '포장은 어떻게 하나요?' }] };
  const rows = Object.fromEntries(['naver', 'coupang', 'ably'].map(platform => [platform, { ...common, platform, store: platform + ' 매장', category: platform === 'ably' ? 'goods' : 'customer', canComplete: platform === 'ably' }]));
  const another = { ...rows.naver, id: '8'.repeat(64), title: '다른 고객 문의' };
  const key = (platform, id) => platform + id;
  const finish = async (platform, text, fail = false) => {
    const route = pending.get(platform); assert.ok(route); pending.delete(platform);
    await route.fulfill({ status: fail ? 429 : 200, contentType: 'application/json', body: JSON.stringify(fail ? { code: 'AI_LIMIT', error: 'OpenAI 사용 한도를 확인해 주세요.' } : { text, fingerprint: 'fixture' }) });
  };
  await page.route('**/api/**', async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname, data = req.method() === 'POST' ? req.postDataJSON() : {}; let result = {};
    if (pathname === '/api/session') result = { csrf: 'fixture', settings: { tone: '정중하게' }, aiConfigured: configured };
    else if (pathname === '/api/reviews') result = { reviews: [], drafts: {} };
    else if (pathname === '/api/status') result = { connected: true, aiConfigured: configured };
    else if (pathname.startsWith('/api/inquiries/')) {
      const [, , , platform, id, action] = pathname.split('/'), row = id === another.id ? another : rows[platform];
      if (id === 'sync') result = { store: row.store, checkedAt: new Date().toISOString(), items: [{ id: row.category, count: 1 }] };
      else if (id === 'list') result = { store: row.store, records: platform === 'naver' ? [row, another] : [row] };
      else if (action === 'detail') result = { ...row, draft: drafts.get(key(platform, id)) || '' };
      else if (action === 'draft') { drafts.set(key(platform, id), data.text); result = { saved: true }; }
      else if (action === 'suggest') { requests.push({ platform, id, data }); pending.set(platform, route); return; }
      else assert.fail('No send or completion action expected: ' + pathname);
    } else assert.fail(pathname);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  const start = async prefix => { const request = page.waitForRequest(r => r.url().endsWith('/suggest')); await page.locator(`#${prefix}inbox-generate`).click(); await request; };
  await page.goto(appUrl + '/#inquiries'); await page.locator('[data-inquiry-category="customer"]').click(); await page.locator(`[data-inbox-id="${common.id}"]`).click();
  await start(''); assert.equal(await page.locator('#inbox-prepare').isDisabled(), true); assert.equal(await page.locator('#inbox-reply').isEnabled(), true);
  await page.locator('#inbox-reply').fill('직접 작성한 답변'); await finish('naver', '네이버 GPT 제안입니다.');
  await page.locator('#inbox-apply-suggestion').waitFor(); assert.equal(await page.locator('#inbox-reply').inputValue(), '직접 작성한 답변');
  await page.locator('#inbox-apply-suggestion').click(); assert.equal(await page.locator('#inbox-reply').inputValue(), '네이버 GPT 제안입니다.');
  await page.locator('#inbox-reply').fill(''); await start(''); await page.locator(`[data-inbox-id="${another.id}"]`).click(); await page.locator('#inbox-reply').fill('다른 문의 작성 중');
  await finish('naver', '첫 문의 새 추천입니다.'); await page.getByText('GPT 초안을 만들었습니다. 문의의 추천 내용을 확인해 주세요.', { exact: true }).waitFor();
  assert.equal(await page.locator('#inbox-reply').inputValue(), '다른 문의 작성 중');
  await page.locator(`[data-inbox-id="${common.id}"]`).click(); await page.locator('#inbox-apply-suggestion').waitFor(); assert.equal(await page.locator('#inbox-reply').inputValue(), '');
  await page.locator('[data-inquiry-platform="coupang"]').click(); await page.locator('[data-coupang-inquiry-category="customer"]').click(); await page.locator('#coupang-inquiry-inbox [data-inbox-id]').click();
  await start('coupang-'); await finish('coupang', '쿠팡 고객에게 전할 초안입니다.'); await page.waitForFunction(() => document.querySelector('#coupang-inbox-reply')?.value === '쿠팡 고객에게 전할 초안입니다.');
  assert.equal(await page.locator('#coupang-inbox-apply-suggestion').count(), 0);
  await page.locator('[data-inquiry-platform="ably"]').click(); await page.locator('[data-ably-inquiry-category="goods"]').click(); await page.locator('#ably-inbox-reply').fill('에이블리 작성 중인 답변');
  await page.locator('#ably-inbox-tone').selectOption('custom'); await page.locator('#ably-inbox-custom-tone').fill('공감하면서 간결하게'); await start('ably-');
  assert.equal(requests.at(-1).data.tone, '공감하면서 간결하게'); assert.equal(await page.locator('#ably-inbox-complete').isDisabled(), true);
  await page.locator('[data-inquiry-platform="coupang"]').click(); await finish('ably', '에이블리 <script>unsafe()</script> 추천입니다.');
  assert.equal(await page.locator('#coupang-inbox-reply').inputValue(), '쿠팡 고객에게 전할 초안입니다.');
  await page.locator('[data-inquiry-platform="ably"]').click(); await page.locator('#ably-inbox-apply-suggestion').waitFor(); assert.equal(await page.locator('#ably-inbox-reply').inputValue(), '에이블리 작성 중인 답변');
  assert.equal(await page.locator('.inbox-ai-suggestion script').count(), 0);
  await page.screenshot({ path: '.local/inquiry-ai-desktop.png', fullPage: true });
  await page.locator('#ably-inbox-apply-suggestion').click(); await start('ably-'); await finish('ably', '', true); await page.locator('#ably-inbox-error').getByText('OpenAI 사용 한도를 확인해 주세요.').waitFor();
  assert.equal(await page.locator('#ably-inbox-reply').inputValue(), '에이블리 <script>unsafe()</script> 추천입니다.');
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.local/inquiry-ai-mobile.png', fullPage: true });
  assert.deepEqual(errors, []); assert.equal(requests.length, 5);
  await page.waitForFunction(() => document.querySelector('#ably-inbox-save-status')?.textContent === '초안 저장됨');
  configured = false; await page.reload(); await page.locator('[data-inquiry-category="customer"]').click(); await page.locator(`#inquiry-inbox [data-inbox-id="${common.id}"]`).click(); await page.locator('#inbox-generate').click();
  await page.locator('#settings-dialog[open]').waitFor(); assert.equal(requests.length, 5);
});

test('Ably conversation opens immediately, shows card text and confirms completion without sending drafts', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], actions = [];
  page.on('pageerror', e => errors.push(e.message)); let draft = '', uncertain = false;
  const row = { id: 'f'.repeat(64), store: '에이블리 테스트', category: 'order_after_delivery', title: '주문 / 반품', content: '포장해서 문 앞에 두면 되나요?', author: '고객', date: '2026-11-18T04:00:00Z', status: 'pending', statusLabel: '진행 중', canReply: true, canComplete: true, fingerprint: 'fixture', replyLimit: 3000, messages: [{ id: '1', role: 'system', label: '자동 안내', text: '반품 접수 방법\n앱 > 주문 내역 > 반품 접수\n\n선택 항목: 문의 계속하기' }, { id: '2', role: 'seller', text: '회수 접수를 도와드리겠습니다.' }, { id: '3', role: 'customer', text: '포장해서 문 앞에 두면 되나요?' }] };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), data = request.method() === 'POST' ? request.postDataJSON() : {}; let result = {}, status = 200;
    if (url.pathname === '/api/session') result = { csrf: 'fixture', settings: {} };
    else if (url.pathname === '/api/status') result = { connected: true };
    else if (url.pathname === '/api/reviews') result = { reviews: [], drafts: {} };
    else if (url.pathname.endsWith('/sync')) result = { store: row.store, checkedAt: new Date().toISOString(), items: [{ id: 'order_after_delivery', count: row.status === 'pending' ? 1 : 0 }] };
    else if (url.pathname.endsWith('/list')) result = { store: row.store, records: row.status === 'pending' ? [row] : [], checkedAt: new Date().toISOString() };
    else if (url.pathname.endsWith('/detail')) result = { ...row, draft };
    else if (url.pathname.endsWith('/draft')) { draft = data.text; result = { saved: true }; }
    else if (url.pathname.endsWith('/complete-prepare')) { actions.push('prepare'); result = { token: 'completion', inquiry: { ...row, draft } }; }
    else if (url.pathname.endsWith('/complete')) {
      actions.push('complete'); assert.equal(data.token, 'completion');
      if (uncertain) { row.completionAttempt = { state: 'uncertain' }; status = 409; result = { error: '완료 처리 결과를 확인 중입니다.', code: 'INQUIRY_COMPLETION_UNCERTAIN' }; }
      else { Object.assign(row, { status: 'answered', statusLabel: '처리 완료', canComplete: false, completionAttempt: { state: 'completed' } }); result = { completed: true, inquiry: { ...row, draft } }; }
    } else assert.fail('Unexpected mutation ' + url.pathname);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl + '/#inquiries'); await page.locator('[data-inquiry-platform="ably"]').click(); await page.locator('[data-ably-inquiry-category="order_after_delivery"]').click();
  await page.locator('#ably-inbox-reply').waitFor(); assert.equal(await page.locator('#ably-inquiry-inbox [data-inbox-id][aria-pressed="true"]').count(), 1);
  assert.match(await page.locator('#ably-inquiry-inbox .inbox-messages').innerText(), /반품 접수 방법/); assert.match(await page.locator('#ably-inquiry-inbox .inbox-item-title').innerText(), /포장해서 문 앞/);
  await page.locator('#ably-inbox-reply').fill('아직 보내지 않은 초안'); await page.locator('#ably-inbox-complete').click(); await page.getByRole('heading', { name: '이 문의를 완료 처리할까요?' }).waitFor();
  assert.deepEqual(actions, ['prepare']); assert.match(await page.locator('#ably-inbox-confirm-body').innerText(), /초안으로 보관/); await page.locator('#ably-inbox-confirm-cancel').click(); assert.deepEqual(actions, ['prepare']);
  await page.locator('#ably-inbox-complete').click(); await page.locator('#ably-inbox-confirm-send').click(); await page.locator('#ably-inbox-confirm[open]').waitFor({ state: 'hidden' });
  assert.deepEqual(actions, ['prepare', 'prepare', 'complete']); assert.equal(await page.locator('#ably-inbox-complete').count(), 0); assert.equal(await page.locator('#ably-inbox-reply').inputValue(), '아직 보내지 않은 초안'); assert.equal(await page.locator('#ably-inquiry-inbox [data-inbox-id]').count(), 0);
  Object.assign(row, { status: 'pending', statusLabel: '진행 중', canComplete: true, completionAttempt: null }); uncertain = true;
  await page.locator('#ably-inbox-refresh').click(); await page.locator('#ably-inbox-complete').waitFor(); await page.locator('#ably-inbox-complete').click(); await page.locator('#ably-inbox-confirm-send').click(); await page.locator('#ably-inbox-confirm[open]').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#ably-inbox-complete').isDisabled(), true); assert.equal(await page.locator('#ably-inbox-reply').count(), 0);
  Object.assign(row, { status: 'answered', statusLabel: '처리 완료', canComplete: false, completionAttempt: { state: 'completed' } });
  await page.locator('#ably-inbox-detail-refresh').click(); await page.locator('#ably-inbox-reply').waitFor(); assert.equal(await page.locator('#ably-inquiry-count-order_after_delivery').innerText(), '0');
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
});

test('Ably inquiry UI selects seven categories, keeps platform drafts separate and confirms exact replies', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [], sends = [], drafts = {}, categories = ['goods', 'order_before_delivery', 'order_after_delivery', 'order_etc', 'etc', 'place', 'affiliate_sponsorship'];
  page.on('pageerror', e => errors.push(e.message)); let failed = false, prepared = '';
  const common = { id: 'e'.repeat(64), content: '회수는 언제 하나요? <script>bad()</script>', author: '고객', title: '주문 / 반품', product: '상품', date: '2026-11-18T04:00:00Z', status: 'pending', canReply: true, fingerprint: 'fixture', replyLimit: 3000, messages: [{ id: '1', role: 'customer', text: '회수는 언제 하나요?' }] };
  const rows = { ably: { ...common, store: '에이블리 매장', category: 'order_after_delivery' }, naver: { ...common, store: '네이버 매장', category: 'customer' }, coupang: { ...common, store: '쿠팡 매장', category: 'customer' } };
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), data = req.method() === 'POST' ? req.postDataJSON() : {}; let result = {}, status = 200;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: {} };
    else if (url.pathname === '/api/reviews') result = { reviews: [], drafts: {} };
    else if (url.pathname === '/api/status') result = { connected: true };
    else if (url.pathname.startsWith('/api/inquiries/')) {
      const [, , , platform, id, action] = url.pathname.split('/'), row = rows[platform];
      if (id === 'sync') {
        if (platform === 'ably' && failed) { status = 409; result = { code: 'ABLY_LOGIN_REQUIRED', error: '에이블리 로그인 확인이 필요합니다.' }; }
        else result = { store: row.store, checkedAt: new Date().toISOString(), items: (platform === 'ably' ? categories : platform === 'coupang' ? ['customer', 'center'] : ['talktalk', 'customer', 'product', 'center']).map(id => ({ id, count: id === 'order_after_delivery' ? 1 : 0 })) };
      } else if (id === 'list') { if (platform === 'ably') assert.equal(data.period, 'pending'); result = { records: data.category === row.category ? [row] : [], store: row.store, checkedAt: new Date().toISOString() }; }
      else if (action === 'detail') result = { ...row, draft: drafts[platform] || '' };
      else if (action === 'draft') { drafts[platform] = data.text; result = { saved: true }; }
      else if (action === 'prepare') { prepared = data.text; result = { token: 'intent', text: data.text, inquiry: row }; }
      else if (action === 'publish') { sends.push({ platform, text: prepared }); row.messages = [...row.messages, { id: '2', role: 'seller', text: prepared }]; result = { sent: true, inquiry: { ...row, draft: '' } }; }
      else assert.fail(url.pathname);
    } else assert.fail(url.pathname);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl + '/#inquiries');
  await page.locator('[data-inquiry-category="customer"]').click(); await page.locator('#inquiry-inbox [data-inbox-id]').click(); await page.locator('#inbox-reply').fill('네이버 초안');
  await page.locator('[data-inquiry-platform="coupang"]').click(); await page.locator('[data-coupang-inquiry-category="customer"]').click(); await page.locator('#coupang-inquiry-inbox [data-inbox-id]').click(); await page.locator('#coupang-inbox-reply').fill('쿠팡 초안');
  await page.locator('[data-inquiry-platform="ably"]').click(); assert.equal(await page.locator('[data-ably-inquiry-category]').count(), 7);
  await page.locator('[data-ably-inquiry-category="goods"]').click(); await page.locator('#ably-inbox-list').getByText('표시할 문의가 없습니다').waitFor();
  await page.locator('[data-ably-inquiry-category="order_after_delivery"]').click(); await page.locator('#ably-inquiry-inbox [data-inbox-id]').click(); await page.locator('#ably-inbox-reply').fill('회수 접수 후 안내드리겠습니다.');
  assert.equal(await page.locator('[data-ably-inquiry-category="order_after_delivery"]').getAttribute('aria-pressed'), 'true');
  for (const platform of ['naver', 'coupang']) { await page.locator(`[data-inquiry-platform="${platform}"]`).click(); assert.equal(await page.locator(platform === 'naver' ? '#inbox-reply' : '#coupang-inbox-reply').inputValue(), platform === 'naver' ? '네이버 초안' : '쿠팡 초안'); }
  await page.locator('[data-inquiry-platform="ably"]').click(); await page.locator('#ably-inbox-prepare').click(); await page.locator('#ably-inbox-confirm[open]').waitFor(); assert.equal(sends.length, 0);
  assert.match(await page.locator('#ably-inbox-confirm-body').innerText(), /에이블리 매장/); assert.equal(await page.locator('#ably-inbox-confirm-body script').count(), 0);
  await page.locator('#ably-inbox-confirm-send').click(); await page.locator('#ably-inbox-confirm[open]').waitFor({ state: 'hidden' }); assert.deepEqual(sends, [{ platform: 'ably', text: '회수 접수 후 안내드리겠습니다.' }]);
  assert.equal(await page.locator('#ably-inbox-reply').inputValue(), '');
  failed = true; await page.locator('#ably-inquiry-refresh').click(); await page.locator('#ably-inquiry-connect').waitFor(); assert.equal(await page.locator('#ably-inquiry-count-order_after_delivery').innerText(), '—');
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#inquiry-platform-mobile').selectOption('naver'); await page.locator('#inquiry-platform-mobile').selectOption('ably'); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
});

test('Coupang inquiry UI isolates drafts and confirmation from Naver, including confirmation-only tickets', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [], sends = [];
  page.on('pageerror', e => errors.push(e.message));
  const common = { id: 'c'.repeat(64), title: '배송 문의', content: '<script>unsafe()</script> 언제 오나요?', author: '고객', product: '상품', date: '2026-11-18', status: 'pending', canReply: true, fingerprint: 'fixture', replyLimit: 2000, messages: [{ id: '1', role: 'customer', text: '언제 오나요?' }] };
  const rows = { naver: { ...common, store: '네이버 매장', category: 'customer' }, coupang: { ...common, store: '쿠팡 매장', category: 'customer' }, center: { ...common, id: 'd'.repeat(64), store: '쿠팡 매장', category: 'center', replyMode: 'confirm', confirmationText: '[쿠팡 시스템] 판매자님이 확인하신 CS문의입니다.' } };
  const drafts = {}, prepared = {}; let failed = false;
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), data = req.method() === 'POST' ? req.postDataJSON() : {}; let result = {}, status = 200;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: {}, aiConfigured: false };
    else if (url.pathname === '/api/reviews') result = { reviews: [], drafts: {} };
    else if (url.pathname === '/api/status') result = { connected: true };
    else if (url.pathname.startsWith('/api/inquiries/')) {
      const [, , , platform, id, action] = url.pathname.split('/'), row = id === rows.center.id ? rows.center : rows[platform];
      if (id === 'sync') {
        if (platform === 'coupang' && failed) { status = 409; result = { code: 'COUPANG_LOGIN_REQUIRED', error: '쿠팡 로그인 확인이 필요합니다.' }; }
        else result = { store: rows[platform].store, targetDay: 30, checkedAt: new Date().toISOString(), items: (platform === 'naver' ? ['talktalk', 'customer', 'product', 'center'] : ['center', 'customer']).map(id => ({ id, count: 0 })) };
      } else if (id === 'list') { assert.equal(data.period, platform === 'coupang' ? '1m' : '3m'); result = { records: [data.category === 'center' ? rows.center : row], store: row.store, checkedAt: new Date().toISOString() }; }
      else if (action === 'detail') result = { ...row, draft: drafts[platform + id] || '' };
      else if (action === 'draft') { drafts[platform + id] = data.text; result = { saved: true }; }
      else if (action === 'prepare') { prepared[id] = data.text; result = { token: 'intent-' + id, text: data.text, inquiry: row }; }
      else if (action === 'publish') { sends.push({ platform, id, text: prepared[id] }); row.canReply = false; row.status = 'answered'; row.messages.push({ id: '2', role: 'seller', text: prepared[id] }); result = { sent: true, inquiry: row }; }
      else assert.fail('Unexpected inquiry request ' + url.pathname);
    } else assert.fail('Unexpected request ' + url.pathname);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl + '/#inquiries'); await page.locator('[data-inquiry-category="customer"]').click(); await page.locator('#inquiry-inbox [data-inbox-id]').click();
  await page.locator('#inbox-reply').fill('네이버 초안은 유지하세요.');
  await page.locator('[data-inquiry-platform="coupang"]').click(); await page.locator('[data-coupang-inquiry-category="customer"]').click(); await page.locator('#coupang-inquiry-inbox [data-inbox-id]').click();
  await page.locator('#coupang-inbox-reply').fill('쿠팡 고객에게 전달할 답변입니다.');
  await page.locator('[data-inquiry-platform="naver"]').click(); assert.equal(await page.locator('#inbox-reply').inputValue(), '네이버 초안은 유지하세요.');
  await page.locator('[data-inquiry-platform="coupang"]').click(); assert.equal(await page.locator('#coupang-inbox-reply').inputValue(), '쿠팡 고객에게 전달할 답변입니다.');
  await page.locator('#coupang-inbox-prepare').click(); await page.locator('#coupang-inbox-confirm[open]').waitFor(); assert.equal(sends.length, 0);
  assert.match(await page.locator('#coupang-inbox-confirm-body').innerText(), /쿠팡 매장/); assert.equal(await page.locator('#coupang-inbox-confirm-body script').count(), 0);
  await page.locator('#coupang-inbox-confirm-send').click(); await page.locator('#coupang-inbox-confirm[open]').waitFor({ state: 'hidden' });
  assert.equal(sends.length, 1); assert.equal(sends[0].platform, 'coupang'); assert.equal(sends[0].text, '쿠팡 고객에게 전달할 답변입니다.');
  await page.locator('[data-coupang-inquiry-category="center"]').click(); await page.locator('#coupang-inquiry-inbox [data-inbox-id]').click();
  assert.equal(await page.locator('#coupang-inbox-reply').getAttribute('readonly'), '');
  assert.equal(await page.locator('#coupang-inbox-generate').count(), 0);
  await page.locator('#coupang-inbox-prepare').click(); await page.getByRole('heading', { name: '확인완료로 처리할까요?' }).waitFor(); assert.equal(sends.length, 1);
  await page.locator('#coupang-inbox-confirm-send').click(); await page.locator('#coupang-inbox-confirm[open]').waitFor({ state: 'hidden' }); assert.equal(sends[1].text, rows.center.confirmationText);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(el => el.id); return new Set(ids).size === ids.length; }), true);
  failed = true; await page.locator('#coupang-inquiry-refresh').click(); await page.getByText('쿠팡 로그인 확인이 필요합니다.', { exact: true }).waitFor();
  assert.equal(await page.locator('#coupang-inquiry-count-customer').innerText(), '—'); assert.equal(await page.locator('#coupang-inquiry-connect').isVisible(), true);
  assert.deepEqual(errors, []);
});

test('inquiry inbox reads details, retains drafts, confirms exact text and never resends an uncertain answer', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const id = 'a'.repeat(64), id2 = 'b'.repeat(64);
  const inquiry = { id, category: 'customer', sourceId: '123', store: '테스트 매장', title: '배송 일정 문의', content: '<img src=x onerror=alert(1)> 언제 오나요?', author: '고객', product: '테스트 상품', date: '2026-11-18', status: 'pending', canReply: true, fingerprint: 'fixture', replyLimit: 1000, messages: [{ id: '1', role: 'customer', text: '언제 오나요?' }], draft: '' };
  let draft = '', prepared, sends = 0, listRequests = 0;
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), data = req.method() === 'POST' ? req.postDataJSON() : {}; let result = {}, status = 200;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: {}, aiConfigured: false };
    else if (url.pathname === '/api/reviews') result = { reviews: [], drafts: {} };
    else if (url.pathname === '/api/status') result = { connected: true };
    else if (url.pathname === '/api/inquiries/naver/sync') result = { store: '테스트 매장', checkedAt: new Date().toISOString(), items: ['talktalk', 'customer', 'product', 'center'].map(id => ({ id, count: 0 })) };
    else if (url.pathname.endsWith('/list')) { listRequests++; result = { records: data.category === 'customer' ? [inquiry, { ...inquiry, id: id2, title: '두 번째 문의' }] : [], store: inquiry.store, checkedAt: new Date().toISOString() }; }
    else if (url.pathname.endsWith('/detail')) result = { ...inquiry, id: url.pathname.split('/')[4], draft };
    else if (url.pathname.endsWith('/draft')) { draft = data.text; result = { saved: true }; }
    else if (url.pathname.endsWith('/prepare')) { prepared = data.text; result = { token: 'confirmed', text: prepared, inquiry }; }
    else if (url.pathname.endsWith('/publish')) { sends++; inquiry.attempt = { state: 'uncertain' }; status = 409; result = { code: 'INQUIRY_UNCERTAIN', error: '등록 결과를 확인 중입니다.' }; }
    else assert.fail('Unexpected request ' + url.pathname);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl + '/#inquiries'); await page.locator('[data-inquiry-category="customer"]').click();
  await page.locator(`[data-inbox-id="${id}"]`).click(); await page.locator('#inbox-reply').fill('내일 출고될 예정입니다.');
  await page.locator(`[data-inbox-id="${id2}"]`).click(); await page.locator('#inbox-reply').waitFor();
  await page.locator(`[data-inbox-id="${id}"]`).click(); await page.locator('#inbox-reply').waitFor();
  assert.equal(await page.locator('#inbox-reply').inputValue(), '내일 출고될 예정입니다.');
  await page.locator('#inbox-prepare').click(); await page.locator('#inbox-confirm[open]').waitFor(); assert.equal(sends, 0);
  assert.equal(await page.locator('#inbox-confirm-text').innerText(), '내일 출고될 예정입니다.'); assert.equal(await page.locator('#inbox-confirm-body img').count(), 0);
  await page.locator('#inbox-confirm-cancel').click(); assert.equal(sends, 0);
  await page.locator('#inbox-reply').fill('확인 결과 모레 출고 예정입니다.'); await page.locator('#inbox-prepare').click();
  await page.locator('#inbox-confirm-send').click(); await page.locator('#inbox-confirm[open]').waitFor({ state: 'hidden' });
  assert.equal(prepared, '확인 결과 모레 출고 예정입니다.'); assert.equal(sends, 1); assert.equal(await page.locator('#inbox-prepare').count(), 0);
  await page.locator('#inbox-detail-refresh').click(); await page.getByText('답변 등록 결과를 확인 중입니다.', { exact: false }).waitFor(); assert.equal(sends, 1);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(listRequests, 1); assert.deepEqual(errors, []);
});

test('Naver inquiry workspace separates navigation, preserves review drafts, opens exact categories and shows failures as unknown', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), calls = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let failed = false, draft = '';
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()); let result = {}, status = 200;
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: { brand: '테스트' }, aiConfigured: false };
    else if (url.pathname === '/api/reviews') result = { reviews: [{ id: '123', product: '상품', content: '후기', author: '고객', date: '2026.11.18', rating: 5, hasReply: false }], drafts: draft ? { '123': { text: draft } } : {} };
    else if (url.pathname === '/api/status') result = { connected: true, aiConfigured: false };
    else if (url.pathname.endsWith('/draft')) { draft = req.postDataJSON().text; }
    else if (url.pathname === '/api/inquiries/naver/sync') {
      calls.push(url.pathname);
      if (failed) { status = 409; result = { error: '네이버 로그인 확인이 필요합니다.', code: 'LOGIN_REQUIRED' }; }
      else result = { platform: 'naver', store: '테스트', checkedAt: new Date().toISOString(), items: ['talktalk', 'customer', 'product', 'center'].map((id, i) => ({ id, count: i })) };
    }
    else if (url.pathname === '/api/inquiries/naver/list') { calls.push(req.postDataJSON().category); result = { records: [], store: '테스트', checkedAt: new Date().toISOString() }; }
    else assert.fail('Unexpected endpoint: ' + url.pathname);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#reply-editor').fill('탭을 바꿔도 남아 있는 리뷰 초안');
  await page.locator('#inquiry-workspace-tab').click();
  await page.waitForFunction(() => document.querySelector('#inquiry-count-center').textContent === '3');
  assert.equal(await page.locator('#review-workspace').isVisible(), false);
  assert.equal(await page.locator('#inquiry-count-talktalk').innerText(), '0');
  assert.equal(await page.locator('#inquiry-workspace').getByRole('button', { name: '전체', exact: true }).count(), 0);
  assert.equal(await page.locator('#inquiry-workspace [data-platform]').count(), 0);
  await page.locator('[data-inquiry-category="customer"]').click();
  await page.waitForFunction(() => document.querySelector('#inbox-refresh') && !document.querySelector('#inbox-refresh').disabled);
  assert.ok(calls.includes('customer'));
  failed = true; await page.locator('#inquiry-refresh').click();
  await page.getByText('네이버 로그인 확인이 필요합니다.', { exact: true }).waitFor();
  assert.equal(await page.locator('#inquiry-count-center').innerText(), '—'); assert.equal(await page.locator('#inquiry-connect').isVisible(), true);
  failed = false; await page.locator('#inquiry-refresh').click();
  await page.waitForFunction(() => document.querySelector('#inquiry-count-center').textContent === '3');
  assert.equal(await page.locator('#inquiry-connect').isVisible(), false);
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  await page.locator('#review-workspace-tab').click();
  assert.equal(await page.locator('#reply-editor').inputValue(), '탭을 바꿔도 남아 있는 리뷰 초안');
  assert.deepEqual(errors, []);
});

test('update UI saves pending drafts before installer launch and remains usable on mobile', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), calls = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const version = { currentVersion: '1.0.0', latestVersion: '1.1.0', available: true, phase: 'available', message: '새 버전 1.1.0을 설치할 수 있습니다.' };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()); let result = {};
    if (url.pathname === '/api/session') result = { csrf: 'test', settings: { brand: '테스트' }, aiConfigured: false, app: { version: '1.0.0' } };
    else if (url.pathname === '/api/reviews') result = { reviews: [{ id: '12345', platform: 'naver', product: '상품', author: '고객', content: '후기', date: '2026.11.15', rating: 5, hasReply: false }], drafts: {} };
    else if (url.pathname === '/api/status') result = { connected: true, aiConfigured: false };
    else if (url.pathname === '/api/app/update') result = { ...version, available: false, phase: 'idle' };
    else if (url.pathname === '/api/app/update/check') result = version;
    else if (url.pathname.endsWith('/draft')) { calls.push({ route: 'draft', text: request.postDataJSON().text }); }
    else if (url.pathname === '/api/app/update/install') { assert.equal(request.postDataJSON().confirmed, true); assert.equal(calls.at(-1).text, '업데이트 전에 저장할 답글'); calls.push({ route: 'install' }); result = { ...version, phase: 'installing', message: '설치 창에서 업데이트를 완료해 주세요.' }; }
    else assert.fail('Unexpected endpoint: ' + url.pathname);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto(appUrl); await page.locator('#reply-editor').fill('업데이트 전에 저장할 답글');
  await page.locator('#app-update-open').click(); assert.equal(await page.locator('#app-update-install').isDisabled(), true);
  await page.locator('#app-update-check').click(); await page.waitForFunction(() => !document.querySelector('#app-update-install').disabled);
  await page.locator('#app-update-install').click(); await page.getByText('설치 창에서 업데이트를 완료해 주세요.', { exact: true }).waitFor();
  assert.equal(calls.at(-1).route, 'install'); assert.equal(await page.locator('#app-update-install').isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('[data-close="app-update-dialog"]').click(); assert.deepEqual(errors, []);
});

test('credential transfer UI downloads only the encrypted file, requires confirmation, clears secrets, and handles a wrong password', async t => {
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({acceptDownloads:true,viewport:{width:1280,height:1000}}),requests=[],errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const backup={format:'review-desk-login-backup',version:1,ciphertext:'encrypted-fixture-only'};
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),data=route.request().postData()?route.request().postDataJSON():null;let result={};let status=200;
    if(url.pathname==='/api/session')result={csrf:'test',settings:{brand:'테스트'},aiConfigured:false};
    else if(url.pathname==='/api/reviews')result={reviews:[],drafts:{}};
    else if(url.pathname==='/api/status')result={connected:false,aiConfigured:false};
    else if(url.pathname==='/api/credentials/export'){requests.push({route:url.pathname,data});result={backup,providers:['naver','baemin'],includesGPT:true};}
    else if(url.pathname==='/api/credentials/import'){requests.push({route:url.pathname,data});if(data.password==='wrong-password'){status=400;result={error:'이전 파일의 암호가 다릅니다.'};}else result={providers:['naver','baemin'],includesGPT:true,aiConfigured:true,aiKey:{saved:true}};}
    else assert.fail('Unexpected endpoint '+url.pathname);
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto(appUrl);await page.locator('#transfer-open').click();
  await page.locator('#transfer-export-password').fill('test-password');await page.locator('#transfer-export-confirm').fill('different-password');await page.locator('#transfer-export-button').click();
  assert.equal(requests.length,0);assert.match(await page.locator('#transfer-message').innerText(),/서로 다릅니다/);
  await page.locator('#transfer-export-password').fill('test-password');await page.locator('#transfer-export-confirm').fill('test-password');
  const downloaded=page.waitForEvent('download');await page.locator('#transfer-export-button').click();const file=await downloaded;
  assert.deepEqual(JSON.parse(await readFile(await file.path(),'utf8')),backup);assert.equal(requests[0].data.password,'test-password');assert.equal(await page.locator('#transfer-export-password').inputValue(),'');
  const choose=()=>page.locator('#transfer-file').setInputFiles({name:'login.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await choose();await page.locator('#transfer-import-password').fill('wrong-password');await page.locator('#transfer-import-button').click();assert.equal(requests.length,1);
  await page.locator('#transfer-confirm-replace').check();await page.locator('#transfer-import-button').click();await page.getByText('이전 파일의 암호가 다릅니다.',{exact:true}).waitFor();assert.equal(await page.locator('#transfer-import-password').inputValue(),'');
  await page.locator('#transfer-import-password').fill('test-password');await page.locator('#transfer-import-button').click();await page.waitForFunction(()=>document.querySelector('#transfer-message').textContent.includes('복원이 완료'));
  assert.equal(requests.at(-1).data.confirmed,true);assert.deepEqual(requests.at(-1).data.backup,backup);assert.equal(await page.locator('#transfer-file').inputValue(),'');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#transfer-export-password').fill('clear-on-close');await page.locator('[data-close="transfer-dialog"]').click();await page.waitForFunction(()=>document.querySelector('#transfer-export-password').value==='');assert.deepEqual(errors,[]);
});

test('one shared period refreshes every top store count, survives switching tabs, and never labels stale results as current', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const channels = ['naver','coupang','ably','baemin-teawest','baemin-besti','coupangeats-teawest','coupangeats-besti'];
  const rows = channels.flatMap(platform => ['2026.11.10','2026.06.10','2026.01.10'].map((date,i) => ({ id: `${platform}-${i}`, platform, product: '상품', content: '기간별 후기', author: '고객', rating: 5, date, hasReply: false })));
  const metadata = (period, sequence) => Object.fromEntries(channels.map(p => [p,{period,from:period==='1m'?'2026-10-16':'2025-11-16',to:'2026-11-15',lastSync:new Date(Date.UTC(2026,10,15,0,0,sequence==='before'?0:sequence==='partial'?1:Number(sequence)+1)).toISOString()}]));
  let data = { reviews: rows, drafts: {}, reviewPeriod:'1y', syncs: metadata('1y','before') }, finish, partialFailure = false;
  const hold = new Promise(resolve => { finish = resolve; });
  await page.route('**/api/**', async route => {
    const req=route.request(), url=new URL(req.url()); let result;
    if(url.pathname==='/api/session') result={csrf:'test',settings:{brand:'테스트'},aiConfigured:false};
    else if(url.pathname==='/api/status') result={connected:true,aiConfigured:false};
    else if(url.pathname==='/api/reviews') result=data;
    else if(url.pathname==='/api/period') {data.reviewPeriod=req.postDataJSON().period;result={...data,missing:channels};}
    else if(url.pathname==='/api/sync') {
      const query=req.postDataJSON(); requests.push(query); assert.equal(query.platform,'all');
      if(requests.length===1) await hold;
      const old=data, reviewPeriod=query.period;
      const reviews=rows.filter(r=>reviewPeriod==='1m'?r.date>'2026.10.15':true);
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
  data={...data,syncProgress:{'baemin-teawest':{phase:'syncing',period:'1m',window:1,windows:1,rows:40,total:80}}};
  await page.waitForFunction(()=>document.querySelector('#period-status').textContent.includes('40/80개 읽음'),{}, {timeout:9000});
  // One provider can finish while the others are still fetching.
  data={...data,syncProgress:{},reviews:data.reviews.filter(r=>r.platform!=='baemin-teawest'||r.date>'2026.10.15'),syncs:{...data.syncs,'baemin-teawest':metadata('1m','partial')['baemin-teawest']}};
  await page.waitForFunction(()=>document.querySelector('#platform-baemin-teawest').textContent==='1',{}, {timeout:9000});
  assert.equal(await page.locator('#platform-coupangeats-teawest').textContent(),'조회 중');
  assert.doesNotMatch(await page.locator('#period-status').textContent(),/40\/80개 읽음/);
  finish(); await page.waitForFunction(()=>!document.querySelector('#period').disabled);
  for(const p of channels) assert.equal(await page.locator(`#platform-${p}`).textContent(),'1');
  await page.locator('.platform-tabs [data-platform="coupangeats-teawest"]').click();
  assert.equal(await page.locator('#period').inputValue(),'1m'); assert.equal(await page.locator('#stat-total').textContent(),'1');
  await page.locator('#period').selectOption('1y'); await page.waitForFunction(()=>!document.querySelector('#period').disabled);
  assert.equal(await page.locator('#platform-coupangeats-teawest').textContent(),'3');
  assert.equal(await page.locator('#platform-baemin-teawest').textContent(),'3');
  assert.doesNotMatch(await page.locator('.platform-tabs [data-platform="baemin-teawest"]').textContent(),/최대 6개월/);
  await page.locator('.platform-tabs [data-platform="baemin-besti"]').click(); assert.equal(await page.locator('#period').inputValue(),'1y');
  assert.equal(await page.locator('#stat-total').textContent(),'3');
  partialFailure=true;
  await page.locator('#period').selectOption('1m'); await page.waitForFunction(()=>!document.querySelector('#period').disabled);
  assert.equal(await page.locator('#platform-baemin-besti').textContent(),'1'); assert.equal(await page.locator('#platform-coupangeats-besti').textContent(),'조회 실패');
  await page.locator('.platform-tabs [data-platform="coupangeats-besti"]').click(); assert.match(await page.locator('#period-status').textContent(),/조회 실패.*최근 1년/);
  await page.reload(); await page.waitForFunction(()=>document.querySelector('#period').value==='1m');
  assert.equal(await page.locator('#platform-coupangeats-besti').textContent(),'조회 필요');
  assert.deepEqual(requests.map(r=>r.period),['1m','1y','1m']); assert.deepEqual(errors,[]);
});

test('cached period switches do not fetch sellers; explicit full check is separate from incremental refresh',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage(),requests=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  let data={reviews:[],drafts:{},reviewPeriod:'1y',syncs:{naver:{period:'1y',total:0}}};
  await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url());let result;
    if(url.pathname==='/api/session')result={csrf:'test',settings:{brand:'테스트'},aiConfigured:false};
    else if(url.pathname==='/api/status')result={connected:true};
    else if(url.pathname==='/api/reviews')result=data;
    else if(url.pathname==='/api/period'){const period=req.postDataJSON().period;data={...data,reviewPeriod:period,syncs:{naver:{period,total:0,mode:'cache'}}};result={...data,missing:[]};}
    else if(url.pathname==='/api/sync'){requests.push(req.postDataJSON());result={...data,warnings:[]};}
    else assert.fail(url.pathname);
    await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto(appUrl);await page.waitForFunction(()=>document.querySelector('#period').value==='1y');
  await page.locator('#period').selectOption('1m');await page.waitForFunction(()=>document.querySelector('#period-status').textContent.includes('저장된 목록'));
  await page.locator('#period').selectOption('1y');await page.waitForFunction(()=>!document.querySelector('#period').disabled);assert.equal(requests.length,0);
  await page.locator('#sync-button').click();await page.waitForFunction(()=>!document.querySelector('#sync-button').disabled);
  await page.locator('#sync-full-button').click();await page.waitForFunction(()=>!document.querySelector('#sync-full-button').disabled);
  assert.deepEqual(requests.map(r=>r.full),[false,true]);assert.deepEqual(errors,[]);
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
  await page.goto(appUrl);
  assert.equal(await page.locator('#auth-open').isVisible(), false);
  await openConnectionSettings(page); await page.locator('#auth-open').waitFor();
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
    await page.reload(); await openConnectionSettings(page); await page.locator(`#${button}`).click(); await page.locator('#delivery-settings-dialog[open]').waitFor(); assert.equal(await page.locator('#delivery-auth-password').inputValue(), ''); assert.equal(await page.locator('#delivery-auth-enabled').isChecked(), true);
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
  assert.match(await page.locator('#live-update-message').innerText(), /3개/);
  assert.equal(await page.locator('#auto-sync-platforms').isVisible(), false);
  assert.match(await page.locator('#auto-sync-alert').innerText(), /1개 확인 필요/);
  await page.locator('#auto-sync-details > summary').click();
  assert.match(await page.locator('#auto-sync-platforms').innerText(), /추가 인증/);
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
  await page.locator('#sync-button').click(); await page.waitForFunction(() => !document.querySelector('#sync-button').disabled); assert.deepEqual(calls[1], { platform: 'all', period: '3m', full:false });
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
  await page.goto(appUrl); await openConnectionSettings(page); await page.locator('#ably-auth-open').click(); await page.locator('#ably-auth-dialog[open]').waitFor();
  await page.locator('#ably-auth-username').fill('synthetic-user'); await page.locator('#ably-auth-password').fill('synthetic-password');
  await page.locator('#ably-auth-form button[type=submit]').click(); await page.locator('#ably-auth-dialog[open]').waitFor({ state: 'hidden' });
  assert.deepEqual(saved, { enabled: true, method: 'ably', username: 'synthetic-user', password: 'synthetic-password' });
  assert.equal(await page.locator('#ably-auth-password').inputValue(), '');
  await page.reload(); await openConnectionSettings(page); await page.locator('.platform-tabs [data-platform="ably"]').click(); await page.getByText('에이블리 추가 인증이 필요합니다.', { exact: false }).first().waitFor();
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
  await page.goto(appUrl); await openConnectionSettings(page); await page.locator('#coupang-auth-open').click(); await page.locator('#coupang-auth-dialog[open]').waitFor();
  await page.locator('#coupang-auth-username').fill('synthetic-user'); await page.locator('#coupang-auth-password').fill('synthetic-password');
  await page.locator('#coupang-auth-form button[type=submit]').click(); await page.locator('#coupang-auth-dialog[open]').waitFor({ state: 'hidden' });
  assert.deepEqual(saved, { enabled: true, method: 'coupang', username: 'synthetic-user', password: 'synthetic-password' });
  assert.equal(await page.locator('#coupang-auth-password').inputValue(), '');
  await page.reload(); await openConnectionSettings(page); await page.locator('.platform-tabs [data-platform="coupang"]').click(); await page.getByText('쿠팡 추가 인증이 필요합니다.', { exact: false }).first().waitFor();
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
  await page.locator('#sync-button').click(); await page.waitForFunction(() => !document.querySelector('#sync-button').disabled); assert.deepEqual(refreshes, [{ period: '6m', platform: 'all', full:false }]);
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
  await page.goto(appUrl); await openConnectionSettings(page); await page.locator('#auth-open').click(); await page.locator('#auth-dialog[open]').waitFor();
  await page.locator('#auth-username').fill('test-only-user'); await page.locator('#auth-password').fill('test-only-password');
  await page.locator('#auth-form button[type=submit]').click(); await page.locator('#auth-dialog[open]').waitFor({ state: 'hidden' });
  assert.equal(input.enabled, true); assert.equal(input.password, 'test-only-password'); assert.equal(await page.locator('#auth-password').inputValue(), '');
  connected = false; autoLogin = { ...autoLogin, blocked: 'verification', phase: 'needs_verification' }; await page.reload(); await openConnectionSettings(page);
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
