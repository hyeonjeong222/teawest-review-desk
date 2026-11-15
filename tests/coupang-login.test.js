import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { AuthVault } from '../src/auth-vault.js';
import { CoupangConnector, COUPANG_REVIEW_URL } from '../src/coupang.js';
import { loginCoupangWithCredentials } from '../src/coupang-login.js';
import { AutoLogin } from '../src/auto-login.js';
import { SerialQueue } from '../src/core.js';
import { createApp } from '../src/server.js';
import { cleanupTestDirectory } from './cleanup.js';
const credentials = { method: 'coupang', username: 'test-coupang-only', password: 'test-password-only!' };

test('Coupang credentials are encrypted independently from Naver, restored and deleted without affecting Naver', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')); t.after(() => cleanupTestDirectory(directory));
  const naver = new AuthVault(directory), coupang = new AuthVault(directory, undefined, { platform: 'coupang' }); await naver.init(); await coupang.init();
  await naver.save({ enabled: true, ...credentials, method: 'naver' }); const original = await readFile(naver.file, 'utf8');
  await coupang.save({ enabled: true, ...credentials });
  const stored = await readFile(coupang.file, 'utf8'); assert.equal(stored.includes(credentials.password), false); assert.equal(stored.includes(credentials.username), false); assert.equal(JSON.stringify(coupang.publicState()).includes(credentials.password), false);
  const restarted = new AuthVault(directory, undefined, { platform: 'coupang' }); await restarted.init(); assert.deepEqual(await restarted.credentials(), credentials);
  await assert.rejects(restarted.save({ enabled: true, ...credentials, method: 'naver' }));
  await restarted.save({ enabled: false }); assert.equal(await restarted.credentials(), null);
  await restarted.forget(); assert.equal(await readFile(naver.file, 'utf8'), original); await assert.rejects(readFile(coupang.file), { code: 'ENOENT' });
});

test('Coupang login submits only once to the observed form and stops for challenges/errors/unknown destinations', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  for (const scenario of ['success', 'popup', 'mfa', 'invalid', 'pre-mfa', 'hostile', 'override']) await t.test(scenario, async () => {
    const context = await browser.newContext(); let submissions = 0, captured;
    await context.exposeBinding('recordLogin', (_, user, password) => { submissions++; captured = { user, password }; });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://wing.coupang.com') return route.fulfill({ contentType: 'text/html', body: '<title>Coupang Wing - test</title><a href="/tenants/cs/product/review">리뷰 목록</a>' });
      const form = `<form id="kc-form-login" method="post" action="${scenario === 'hostile' ? 'https://foreign.example' : url.origin}/auth/realms/seller/login-actions/authenticate"><input id="username"><input id="password" type="password"><input id="kc-login" type="submit" value="로그인" ${scenario === 'override' ? 'formaction="https://foreign.example/receive"' : ''}></form>`;
      const outcome = scenario === 'mfa' ? "document.body.innerHTML='<h1>인증번호를 입력해 주세요</h1><input autocomplete=one-time-code>'" : scenario === 'invalid' ? "document.body.innerHTML='<p>아이디 또는 비밀번호가 일치하지 않습니다.</p>'" : scenario === 'popup' ? `window.open(${JSON.stringify(COUPANG_REVIEW_URL)})` : `location.href=${JSON.stringify(COUPANG_REVIEW_URL)}`;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: scenario === 'pre-mfa' ? '<p>보안 문자를 입력하세요</p><input id="captcha">' : `${form}<script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();await window.recordLogin(document.querySelector('#username').value,document.querySelector('#password').value);${outcome};};</script>` });
    });
    try {
      const page = await context.newPage(); await page.goto('https://xauth.coupang.com/auth/realms/seller/protocol/openid-connect/auth');
      const connector = new CoupangConnector('unused'); connector.connect = async () => ({ contexts: () => [context] }); connector.open = async () => {};
      connector.status = async () => ({ connected: (await connector.getPage()).url().startsWith('https://wing.coupang.com/') });
      if (['hostile', 'override'].includes(scenario)) { await assert.rejects(loginCoupangWithCredentials(connector, credentials, { timeout: 3000 }), /Unrecognized Coupang login destination/); assert.equal(await page.locator('#password').inputValue(), ''); assert.equal(submissions, 0); }
      else {
        const result = await connector.login(credentials);
        if (['mfa', 'pre-mfa'].includes(scenario)) assert.equal(result.reason, 'verification');
        else if (scenario === 'invalid') assert.equal(result.reason, 'invalid_credentials');
        else assert.equal(result.connected, true);
        assert.equal(submissions, scenario === 'pre-mfa' ? 0 : 1);
        if (submissions) assert.deepEqual(captured, { user: credentials.username, password: credentials.password });
      }
    } finally { await context.close(); }
  });
});

test('Coupang status detects server expiry behind a stale title, caches probes and avoids login during network failure', async () => {
  let statusCode = 200, location, calls = 0, unavailable = false;
  const connector = new CoupangConnector('unused');
  connector.getPage = async () => ({ url: () => COUPANG_REVIEW_URL, title: async () => 'Coupang Wing - Test, store', context: () => ({ request: { get: async (url, opts) => { calls++; assert.equal(url, COUPANG_REVIEW_URL); assert.equal(opts.maxRedirects, 0); if (unavailable) throw new Error('offline'); return { status: () => statusCode, headers: () => ({ location, 'content-type': 'text/html' }), dispose: async () => {} }; } } }) });
  assert.equal((await connector.status()).connected, true); await connector.status(); assert.equal(calls, 1);
  statusCode = 302; location = 'http://wing.coupang.com/login'; assert.equal((await connector.status(true)).connected, false);
  statusCode = 200; location = null; assert.equal((await connector.status(true)).connected, true);
  unavailable = true; assert.equal((await connector.status(true)).networkError, true);
  connector.sessionProbe = null;
  const vault = { publicState: () => ({ enabled: true }), block: async () => assert.fail('Network failure must not block saved credentials') };
  connector.login = async () => assert.fail('Network failure must not submit credentials');
  const auth = new AutoLogin(connector, vault, new SerialQueue()); await auth.schedule(); assert.equal(auth.phase, 'offline');
});

test('Coupang auth routes require CSRF, preserve Naver state and never expose credentials or register reviews', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')), port = 14321, base = `http://127.0.0.1:${port}`;
  const connector = { status: async () => ({ connected: true }), login: async () => assert.fail('No Naver login'), publish: async () => assert.fail('No review posting') };
  const coupangConnector = { status: async () => ({ connected: true }), login: async () => assert.fail('Already connected') };
  const { server, csrf, store, autoLogin, coupangAutoLogin } = await createApp({ directory, ablyConnector: { status: async () => ({ connected: false }), sync: async () => ({ reviews: [], total: 0 }) }, connector, coupangConnector, port, maintenanceInterval: 0 });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanupTestDirectory(directory); });
  const post = (route, data, token = csrf) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'X-Review-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await post('/api/auth/coupang/settings', { enabled: true, ...credentials }, 'wrong')).status, 403);
  assert.equal((await post('/api/auth/coupang/settings', { enabled: true })).status, 400);
  const res = await post('/api/auth/coupang/settings', { enabled: true, ...credentials }); assert.equal(res.status, 200); assert.equal((await res.json()).configured, true); await coupangAutoLogin.pending;
  const status = await fetch(base + '/api/status').then(r => r.json()); assert.equal(status.platforms.coupang.autoLogin.enabled, true); assert.equal(autoLogin.publicState().configured, false);
  for (const route of ['/api/status', '/api/session', '/api/reviews']) { const body = await fetch(base + route).then(r => r.text()); assert.equal(body.includes(credentials.username), false); assert.equal(body.includes(credentials.password), false); }
  assert.equal(JSON.stringify(store.data).includes(credentials.password), false); assert.equal((await fetch(base + '/.local/coupang-auth.json')).status, 404);
  assert.equal((await post('/api/auth/coupang/forget', {}, 'bad')).status, 403);
  assert.equal((await post('/api/auth/coupang/forget', {}).then(r => r.json())).configured, false); assert.equal(autoLogin.publicState().configured, false);
});
