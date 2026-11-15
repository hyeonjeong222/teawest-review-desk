export const ABLY_ORIGIN = 'https://my.a-bly.com';
export const ABLY_LOGIN_URL = `${ABLY_ORIGIN}/login`;
export const ABLY_LOGIN_ENDPOINT = 'https://api.a-bly.com/seller/login/';
export function isAblyPage(url) { try { return new URL(url).origin === ABLY_ORIGIN; } catch { return false; } }

export async function ablyLoginScreen(page) {
  if (!isAblyPage(page.url())) return 'unknown';
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  const challenge = page.locator('input[autocomplete="one-time-code"]:visible, input[name*="captcha" i]:visible, input[id*="captcha" i]:visible, input[name*="otp" i]:visible, iframe[src*="captcha"]:visible');
  if (await challenge.count() || /자동\s*입력\s*방지|보안\s*문자|인증\s*번호|인증\s*코드|추가\s*인증|2단계\s*인증|2차\s*인증|본인\s*확인|기기\s*등록|verification\s*code|two.factor|captcha/i.test(text)) return 'verification';
  if (/비밀번호.{0,40}(일치하지|틀[렸립]|잘못|정확|확인해)|아이디.{0,40}(일치하지|잘못|확인해)|이메일.{0,40}(일치하지|잘못|확인해)|로그인.{0,25}(실패|제한|차단)|계정.{0,20}(잠[겼금]|차단)|invalid.{0,30}(password|email)|account.{0,20}(locked|disabled)/i.test(text)) return 'invalid_credentials';
  if (await page.locator('a[href="/seller"]').count()) return 'connected';
  if (new URL(page.url()).pathname === '/login' && await page.locator('form.login-form input[name="email"]').isVisible() && await page.locator('form.login-form input[name="password"]').isVisible()) return 'login';
  return 'unknown';
}

async function safeLoginForm(page) {
  if (!isAblyPage(page.url()) || new URL(page.url()).pathname !== '/login') throw new Error('Unrecognized Ably login origin');
  const form = page.locator('form.login-form');
  if (await form.count() !== 1) throw new Error('Unrecognized Ably login form');
  const destination = await form.evaluate(f => ({ action: f.action, override: f.querySelector('button.login-form__login-button')?.getAttribute('formaction') }));
  const action = new URL(destination.override || destination.action, page.url());
  if (action.origin !== ABLY_ORIGIN || action.pathname !== '/login') throw new Error('Unrecognized Ably login destination');
  for (const selector of ['input[name="email"]', 'input[name="password"][type="password"]', 'button.login-form__login-button[type="button"]']) {
    const field = form.locator(selector);
    if (await field.count() !== 1 || !await field.isVisible() || !await field.isEnabled()) throw new Error('Unrecognized Ably login field');
  }
}

// Submit the official UI once. Redirects and unknown credential destinations are blocked.
export async function loginAblyWithCredentials(connector, credentials, { timeout = 30000 } = {}) {
  if (!credentials || credentials.method !== 'ably') return { connected: false, reason: 'storage_error' };
  await connector.open(false);
  let page = await connector.getPage();
  if (await ablyLoginScreen(page) === 'connected') {
    const status = await connector.status(true);
    if (status.connected) return status;
    if (status.networkError) return { connected: false, reason: 'connection_error' };
    await page.goto(ABLY_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  const deadline = Date.now() + timeout;
  let submitted = false, requests = 0, blocked = false, failed = false, routed = false;
  const guard = async route => {
    const request = route.request(), body = request.postData() || '', url = request.url();
    const containsSecret = [credentials.password, encodeURIComponent(credentials.password), JSON.stringify(credentials.password).slice(1, -1), credentials.username, encodeURIComponent(credentials.username)].some(value => value && (body.includes(value) || url.includes(value)));
    if (url === ABLY_LOGIN_ENDPOINT && request.method() === 'POST') {
      let data; try { data = request.postDataJSON(); } catch { data = null; }
      if (++requests > 1 || !data || data.email !== credentials.username || data.password !== credentials.password || Object.keys(data).some(key => !['email', 'password'].includes(key))) { blocked = true; return route.abort(); }
      let response;
      try {
        response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
        if (response.status() >= 300 && response.status() < 400) { blocked = true; return await route.abort(); }
        if ([401, 403, 429].includes(response.status())) failed = true;
        await route.fulfill({ response });
      } catch { blocked = true; await route.abort().catch(() => {}); }
      finally { await response?.dispose(); }
      return;
    }
    if (containsSecret) { blocked = true; return route.abort(); }
    return route.continue();
  };
  try {
    while (Date.now() < deadline) {
      page = await connector.getPage(); const kind = await ablyLoginScreen(page);
      if (kind === 'connected') { const status = await connector.status(true); if (status.connected) return status; if (status.networkError) return { connected: false, reason: 'connection_error' }; }
      if (kind === 'verification' || kind === 'invalid_credentials') return { connected: false, reason: kind };
      if (blocked) return { connected: false, reason: 'connection_error' };
      if (failed) return { connected: false, reason: 'invalid_credentials' };
      if (kind === 'login' && !submitted) {
        await safeLoginForm(page); await page.route('**/*', guard); routed = true;
        await page.locator('form.login-form input[name="email"]').fill(credentials.username);
        await page.locator('form.login-form input[name="password"]').fill(credentials.password);
        await safeLoginForm(page); submitted = true;
        await page.locator('form.login-form button.login-form__login-button').click({ timeout: 5000 });
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    return { connected: false, reason: 'verification' };
  } finally {
    if (routed) await page.unroute('**/*', guard).catch(() => {});
    if (isAblyPage(page.url()) && new URL(page.url()).pathname === '/login') {
      for (const name of ['email', 'password']) await page.locator(`form.login-form input[name="${name}"]`).fill('', { timeout: 1000 }).catch(() => {});
    }
  }
}
