import { AppError, SerialQueue } from './core.js';

export const deliveryLoginConfig = {
  baemin: { home: 'https://self.baemin.com/', origin: 'https://biz-member.baemin.com', loginPath: '/login', loginUrl: 'https://biz-member.baemin.com/login?returnUrl=https%3A%2F%2Fself.baemin.com%2F', endpoint: '/v1/login', user: 'input[name="id"]', password: 'input[name="password"][type="password"]' },
  coupangeats: { home: 'https://store.coupangeats.com/merchant/management', origin: 'https://store.coupangeats.com', loginPath: '/merchant/login', loginUrl: 'https://store.coupangeats.com/merchant/login', endpoint: '/api/v1/merchant/login', user: 'input#loginId', password: 'input#password[type="password"]' },
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const urlOf = page => { try { return new URL(page.url()); } catch { return null; } };
const challengeText = /자동\s*입력\s*방지|보안\s*문자|인증\s*번호|인증\s*코드|추가\s*인증|2단계\s*인증|2차\s*인증|본인\s*확인|기기\s*등록|비밀번호(?:를|의)?\s*변경(?:이|해).*필요|verification\s*code|two.factor|captcha/i;
const invalidText = /(?:비밀번호|아이디|계정).{0,45}(?:일치하지|틀[렸립]|잘못|올바르지|확인해)|로그인.{0,25}(?:실패|제한|차단)|계정.{0,20}(?:잠[겼금]|차단)|invalid.{0,30}(?:password|username)|account.{0,20}(?:locked|disabled)/i;

export async function deliveryLoginScreen(page, provider) {
  const config = deliveryLoginConfig[provider], url = urlOf(page);
  if (!url || !config || ![config.origin, new URL(config.home).origin].includes(url.origin)) return 'unknown';
  if (/\/(?:check-auth|change-password|new-password|re-agree|inactive)(?:\/|$)/.test(url.pathname)) return 'verification';
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  const challenge = page.locator('input[autocomplete="one-time-code"]:visible, input[name*="captcha" i]:visible, input[id*="captcha" i]:visible, input[name*="otp" i]:visible, iframe[src*="captcha"]:visible');
  if (await challenge.count() || await page.locator('input[type="password"]:visible').count() > 1 || challengeText.test(text)) return 'verification';
  if (invalidText.test(text)) return 'invalid_credentials';
  if (provider === 'baemin' && url.origin === 'https://self.baemin.com' && await page.locator('select option').evaluateAll(options => options.some(o => /^\d+$/.test(o.value)))) return 'connected';
  if (provider === 'coupangeats' && url.origin === config.origin && url.pathname.startsWith('/merchant/management')) return 'connected';
  if (url.origin === config.origin && url.pathname === config.loginPath && await page.locator(config.user).isVisible() && await page.locator(config.password).isVisible()) return 'login';
  return 'unknown';
}

async function safeForm(page, provider, ready = false) {
  const config = deliveryLoginConfig[provider], url = urlOf(page);
  if (url?.origin !== config.origin || url.pathname !== config.loginPath) throw new AppError('공식 로그인 화면을 확인하지 못했습니다.', 409, 'LOGIN_LAYOUT');
  const form = page.locator('form').filter({ has: page.locator(config.password) });
  if (await form.count() !== 1) throw new AppError('로그인 입력창을 확인하지 못했습니다.', 409, 'LOGIN_LAYOUT');
  const button = form.getByRole('button', { name: '로그인', exact: true });
  const destination = await form.evaluate(f => ({ action: f.action, override: f.querySelector('button[type="submit"]')?.getAttribute('formaction') }));
  const action = new URL(destination.override || destination.action, page.url());
  if (action.origin !== config.origin || action.pathname !== (provider === 'baemin' ? '/login' : '/')) throw new AppError('로그인 전송 주소가 변경되었습니다.', 409, 'LOGIN_LAYOUT');
  for (const field of [form.locator(config.user), form.locator(config.password), button]) if (await field.count() !== 1 || !await field.isVisible() || ((field !== button || ready) && !await field.isEnabled())) throw new AppError('로그인 입력창을 사용할 수 없습니다.', 409, 'LOGIN_LAYOUT');
  return { form, button };
}

// Let the official form encrypt/submit credentials. Only its observed login endpoint is allowed.
export async function loginDeliveryWithCredentials(connector, credentials, { timeout = 30000 } = {}) {
  const provider = connector.provider, config = deliveryLoginConfig[provider];
  if (!credentials || credentials.method !== provider) return { connected: false, reason: 'storage_error' };
  let page = await connector.getPage(true), screen = await deliveryLoginScreen(page, provider);
  if (screen === 'connected') {
    const status = await connector.status(true); if (status.connected || status.networkError) return status;
    screen = await deliveryLoginScreen(page, provider);
    if (screen === 'verification' || screen === 'invalid_credentials') return { connected: false, reason: screen };
    if (screen !== 'login') await page.goto(provider === 'baemin' ? config.home : config.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  const protectedValues = [credentials.password, encodeURIComponent(credentials.password), JSON.stringify(credentials.password).slice(1, -1)];
  const usernameValues = [credentials.username, encodeURIComponent(credentials.username)];
  let submitted = false, requests = 0, routed = false, blocked = false, failure = null;
  const guard = async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() || '';
    if (url.origin === config.origin && url.pathname === config.endpoint) {
      let data; try { data = request.postDataJSON(); } catch { data = null; }
      const correct = provider === 'baemin'
        ? data?.id === credentials.username && ['pw', 'value1', 'value2'].every(k => typeof data[k] === 'string' && data[k].length > 0) && !Object.keys(data).some(k => !['id', 'pw', 'value1', 'value2', 'token', 'autoLogin'].includes(k))
        : data?.loginId === credentials.username && data.password === credentials.password && Object.keys(data).every(k => ['loginId', 'password'].includes(k));
      if (request.method() !== 'POST' || ++requests > 1 || !correct || (provider === 'baemin' && body.includes(credentials.password))) { blocked = true; return route.abort(); }
      if (provider === 'baemin') protectedValues.push(data.value1, data.value2, encodeURIComponent(data.value1), encodeURIComponent(data.value2));
      let response;
      try {
        response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
        if (response.status() >= 300 && response.status() < 400) { blocked = true; return await route.abort(); }
        const result = await response.json().catch(() => null);
        const message = String(result?.message || result?.statusMessage || '');
        if (challengeText.test(message) || result?.data?.needCheckIdentity || result?.data?.needPasswordChange) failure = 'verification';
        else if (invalidText.test(message) || result?.status === 'FAIL_WRONG_AUTHENTICATION') failure = 'invalid_credentials';
        else if (response.status() === 429) failure = 'verification';
        else if (response.status() >= 500) failure = 'connection_error';
        await route.fulfill({ response });
      } catch { blocked = true; await route.abort().catch(() => {}); }
      finally { await response?.dispose(); }
      return;
    }
    if (protectedValues.some(value => value && (body.includes(value) || request.url().includes(value)))) { blocked = true; return route.abort(); }
    // Login analytics must not send the account ID to unrelated destinations.
    if (usernameValues.some(value => value && (body.includes(value) || request.url().includes(value)))) { if (/"(?:password|value2)"\s*:/.test(body)) blocked = true; return route.abort(); }
    return route.continue();
  };
  try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      screen = await deliveryLoginScreen(page, provider);
      if (screen === 'verification' || screen === 'invalid_credentials') return { connected: false, reason: screen };
      if (blocked) return { connected: false, reason: 'connection_error' };
      if (failure) return { connected: false, reason: failure };
      if (screen === 'connected') { const status = await connector.status(true); if (status.connected) return status; if (status.networkError) return { connected: false, reason: 'connection_error' }; }
      if (screen === 'login' && !submitted) {
        await safeForm(page, provider); await page.route('**/*', guard); routed = true;
        await page.locator(config.user).fill(credentials.username); await page.locator(config.password).fill(credentials.password);
        const { button } = await safeForm(page, provider, true); submitted = true; await button.click({ timeout: 5000 });
      }
      await sleep(400);
    }
    return { connected: false, reason: submitted ? 'verification' : 'connection_error' };
  } finally {
    if (routed) await page.unroute('**/*', guard).catch(() => {});
    if (urlOf(page)?.origin === config.origin && urlOf(page)?.pathname === config.loginPath) for (const selector of [config.user, config.password]) await page.locator(selector).fill('', { timeout: 1000 }).catch(() => {});
  }
}

// One account/session per provider, shared by its two shop queues. Its own tab never edits reviews.
export class DeliveryAccountConnector {
  constructor(host, provider, onConnected = () => {}) {
    if (!deliveryLoginConfig[provider]) throw new Error('Unsupported delivery provider');
    this.host = host; this.provider = provider; this.config = deliveryLoginConfig[provider]; this.onConnected = onConnected; this.openQueue = new SerialQueue(); this.probeAt = 0; this.wasConnected = false;
  }
  async getPage(create = false) {
    if (this.page && !this.page.isClosed()) return this.page;
    return this.openQueue.run(async () => {
      if (this.page && !this.page.isClosed()) return this.page;
      let browser; try { browser = await this.host.connect(); } catch (error) { if (!create) throw error; await this.host.open(false); browser = await this.host.connect(); }
      const context = browser.contexts()[0];
      // Preserve an existing challenge after a server restart.
      this.page = context.pages().find(p => { const url = urlOf(p); return url?.origin === this.config.origin && (url.pathname === this.config.loginPath || /\/(check-auth|change-password|new-password)(\/|$)/.test(url.pathname)); });
      if (!this.page) { this.page = await context.newPage(); await this.page.goto(this.config.home, { waitUntil: 'domcontentloaded', timeout: 25000 }); }
      this.probeAt = Date.now(); return this.page;
    });
  }
  async status(force = false) {
    try {
      const page = await this.getPage(), kind = await deliveryLoginScreen(page, this.provider);
      if (kind !== 'connected') { this.wasConnected = false; return { connected: false, browserOpen: true }; }
      if (this.provider === 'baemin' && (force || Date.now() - this.probeAt > 60000)) {
        this.probeAt = Date.now(); await page.goto(this.config.home, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForFunction(() => document.querySelector('select option[value]') || document.querySelector('input[name="id"]') || /인증|본인 확인/.test(document.body.innerText), null, { timeout: 10000 }).catch(() => {});
        if (await deliveryLoginScreen(page, this.provider) !== 'connected') { this.wasConnected = false; return { connected: false, browserOpen: true }; }
      }
      if (this.provider === 'coupangeats') {
        const result = await page.evaluate(async () => { const response = await fetch('/api/v1/merchant/web/stores/list-by-pagination?pageSize=2000&pageNum=0', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) }); const body = await response.json().catch(() => null); return { status: response.status, valid: body?.code === 'SUCCESS' && Array.isArray(body?.data?.data) }; });
        if ([401, 403].includes(result.status)) { this.wasConnected = false; return { connected: false, browserOpen: true }; }
        if (result.status !== 200 || !result.valid) return { connected: false, browserOpen: true, networkError: true };
      }
      if (!this.wasConnected) await this.onConnected(); this.wasConnected = true;
      return { connected: true, browserOpen: true };
    } catch (error) { return { connected: false, browserOpen: error.code !== 'BROWSER_REQUIRED', networkError: error.code !== 'BROWSER_REQUIRED' }; }
  }
  async open(focus = true) { const page = await this.getPage(true); if (focus) await page.bringToFront(); return this.status(); }
  async login(credentials) { return loginDeliveryWithCredentials(this, credentials); }
}
