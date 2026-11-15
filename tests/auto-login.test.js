import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { AuthVault } from '../src/auth-vault.js';
import { AutoLogin } from '../src/auto-login.js';
import { SerialQueue } from '../src/core.js';
import { NaverConnector } from '../src/naver.js';
import { loginWithCredentials, REVIEW_URL } from '../src/naver-login.js';
import { cleanupTestDirectory } from './cleanup.js';

const credentials = { method: 'naver', username: 'synthetic-test-user', password: 'synthetic-test-password!' };
test('Windows vault encrypts credentials, survives restart, and exposes no secrets', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')); t.after(() => cleanupTestDirectory(directory));
  const vault = new AuthVault(directory); await vault.init();
  await vault.save({ enabled: true, ...credentials });
  const file = await readFile(vault.file, 'utf8');
  for (const secret of [credentials.username, credentials.password]) { assert.equal(file.includes(secret), false); assert.equal(JSON.stringify(vault.publicState()).includes(secret), false); }
  const reloaded = new AuthVault(directory); await reloaded.init(); assert.deepEqual(await reloaded.credentials(), credentials);
  await reloaded.block('verification'); const restarted = new AuthVault(directory); await restarted.init(); assert.equal(restarted.publicState().blocked, 'verification');
  await restarted.save({ enabled: false }); assert.equal(await restarted.credentials(), null);
  await restarted.forget(); await assert.rejects(readFile(vault.file), { code: 'ENOENT' });
});

function memoryVault() {
  return { data: { enabled: true, configured: true, blocked: null }, publicState() { return { ...this.data }; }, credentials: async () => credentials, async block(blocked) { this.data.blocked = blocked; } };
}

test('password updates preserve the stored account, work while disabled, and require full credentials for account changes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')); t.after(() => cleanupTestDirectory(directory));
  const protect = async (value, decrypt) => decrypt ? value.slice('test-cipher:'.length) : `test-cipher:${value}`;
  for (const platform of ['naver', 'coupang', 'ably']) {
    const vault = new AuthVault(directory, protect, { platform }); await vault.init();
    await assert.rejects(vault.save({ enabled: true, password: 'first-password' }), /처음 연결/);
    await vault.save({ enabled: true, method: platform, username: 'saved-account', password: 'old-password' });
    await vault.save({ enabled: false });
    await vault.save({ enabled: false, username: '', password: 'new-password' });
    const reloaded = new AuthVault(directory, protect, { platform }); await reloaded.init();
    assert.equal(await reloaded.credentials(), null); await reloaded.save({ enabled: true });
    assert.deepEqual(await reloaded.credentials(), { username: 'saved-account', password: 'new-password', method: platform });
    await assert.rejects(reloaded.save({ enabled: true, username: 'different-account' }), /비밀번호/);
    if (platform === 'naver') await assert.rejects(reloaded.save({ enabled: true, method: 'commerce', password: 'wrong-account-password' }), /아이디와 비밀번호/);
    for (const invalid of [null, { enabled: true, password: [] }, { enabled: true, username: {} }]) await assert.rejects(reloaded.save(invalid), error => error.status === 400);
    assert.equal((await reloaded.credentials()).password, 'new-password');
    const visible = JSON.stringify(reloaded.publicState()); assert.equal(visible.includes('saved-account'), false); assert.equal(visible.includes('new-password'), false);
  }
});
test('automatic recovery is single-flight, serialized with publishing, and pauses across restarts for MFA', async () => {
  const vault = memoryVault(), queue = new SerialQueue(); let connected = false, calls = 0, release;
  queue.run(() => new Promise(resolve => { release = resolve; })); await Promise.resolve();
  const connector = { status: async () => ({ connected }), login: async c => { assert.deepEqual(c, credentials); calls++; return { connected: false, reason: 'verification' }; }, publish() { assert.fail('Recovery must never publish'); } };
  const auth = new AutoLogin(connector, vault, queue);
  const a = auth.schedule(), b = auth.schedule(); assert.equal(a, b); assert.equal(calls, 0); release(); await a;
  assert.equal(calls, 1); assert.equal(auth.publicState().phase, 'needs_verification');
  await auth.schedule(); const restarted = new AutoLogin(connector, vault, queue); await restarted.schedule(); assert.equal(calls, 1);
  connected = true; await restarted.schedule(); assert.equal(restarted.publicState().phase, 'connected'); assert.equal(vault.data.blocked, null);
});
test('recovery succeeds once, halts on invalid passwords, and leaves network outages alone', async () => {
  for (const outcome of ['success', 'invalid_credentials', 'network']) {
    const vault = memoryVault(); let connected = false, calls = 0;
    const connector = { status: async () => ({ connected, networkError: outcome === 'network' }), login: async () => { calls++; connected = outcome === 'success'; return { connected, reason: 'invalid_credentials' }; } };
    const auth = new AutoLogin(connector, vault, new SerialQueue()); await auth.schedule(); await auth.schedule();
    assert.equal(calls, outcome === 'network' ? 0 : 1);
    assert.equal(auth.phase, outcome === 'success' ? 'connected' : outcome === 'network' ? 'offline' : 'needs_attention');
  }
});

test('login adapter: both ID types, popup, MFA, wrong passwords, and untrusted form destination', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  for (const scenario of ['naver', 'commerce', 'popup', 'mfa', 'invalid', 'pre-mfa', 'hostile']) await t.test(scenario, async () => {
    const context = await browser.newContext();
    let submissions = 0, captured;
    await context.exposeBinding('recordLogin', (_, user, password) => { submissions++; captured = { user, password }; });
    // All origins, including Naver, are fulfilled locally. No real login requests.
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'sell.smartstore.naver.com') return route.fulfill({ contentType: 'text/html', body: '<span class="shop">테스트 스토어</span>' });
      const isCommerce = url.hostname === 'accounts.commerce.naver.com';
      const body = scenario === 'pre-mfa' ? '<h1>2단계 인증</h1><input autocomplete="one-time-code">' : `
        <form action="${scenario === 'hostile' ? 'https://foreign.example/login' : url.origin}">
        ${isCommerce ? '<input placeholder="아이디 또는 이메일 주소"><input type="password" placeholder="비밀번호">' : '<input id="id"><input id="pw" type="password">'}
        <button type="button" id="login">로그인</button></form>
        ${isCommerce ? '<button id="naver">네이버 아이디로 로그인</button>' : ''}
        <script>
        document.querySelector('#naver')?.addEventListener('click',()=>{${scenario === 'popup' ? "window.open('https://nid.naver.com/oauth2.0/authorize')" : "location.href='https://nid.naver.com/oauth2.0/authorize'"}});
        document.querySelector('#login').onclick=async()=>{
          const fields=document.querySelectorAll('input'); await window.recordLogin(fields[0].value,fields[1].value);
          ${scenario === 'mfa' ? "document.body.innerHTML='<h1>2단계 인증이 필요합니다</h1><input autocomplete=one-time-code>'" : scenario === 'invalid' ? "document.body.innerHTML='<p>아이디 또는 비밀번호를 잘못 입력했습니다.</p>'" : `location.href=${JSON.stringify(REVIEW_URL)}`}
        };</script>`;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    try {
      const page = await context.newPage(); await page.goto('https://accounts.commerce.naver.com/login');
      const connector = new NaverConnector('test-only'); connector.connect = async () => ({ contexts: () => [context] });
      connector.status = async () => { const active = await connector.getPage(); return { connected: active.url().startsWith('https://sell.smartstore.naver.com/') && await active.locator('span.shop').count() === 1 }; };
      const input = { ...credentials, method: scenario === 'commerce' ? 'commerce' : 'naver' };
      if (scenario === 'hostile') { input.method = 'commerce'; await assert.rejects(loginWithCredentials(connector, input, { timeout: 5000 }), /Unrecognized login destination/); assert.equal(submissions, 0); }
      else {
        const result = await connector.login(input);
        if (['mfa', 'pre-mfa'].includes(scenario)) assert.equal(result.reason, 'verification');
        else if (scenario === 'invalid') assert.equal(result.reason, 'invalid_credentials');
        else assert.equal(result.connected, true);
        assert.equal(submissions, scenario === 'pre-mfa' ? 0 : 1);
        if (submissions) assert.deepEqual(captured, { user: credentials.username, password: credentials.password });
      }
    } finally { await context.close(); }
  });
});

test('session status detects expiry despite a stale logged-in header and treats network failure separately', async () => {
  const connector = new NaverConnector('test-only'); let keys = ['read'], unavailable = false;
  const page = { url: () => REVIEW_URL, locator: () => ({ first: () => ({ textContent: async () => '테스트 스토어' }) }), context: () => ({ request: { get: async url => { assert.equal(url, 'https://sell.smartstore.naver.com/api/context'); if (unavailable) throw new Error('offline'); return { status: () => 200, json: async () => ({ menuAccessKeyTypes: keys }) }; } } }) };
  connector.getPage = async () => page;
  assert.equal((await connector.status(true)).connected, true); keys = []; assert.equal((await connector.status(true)).connected, false);
  unavailable = true; assert.equal((await connector.status(true)).networkError, true);
});
