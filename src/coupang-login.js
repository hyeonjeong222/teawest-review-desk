export const COUPANG_ORIGIN = 'https://wing.coupang.com';
export const COUPANG_AUTH_ORIGIN = 'https://xauth.coupang.com';
export function isCoupangPage(url) { try { return [COUPANG_ORIGIN, COUPANG_AUTH_ORIGIN].includes(new URL(url).origin); } catch { return false; } }

export async function coupangLoginScreen(page) {
  if (!isCoupangPage(page.url())) return 'unknown';
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  const challenge = page.locator('input[autocomplete="one-time-code"]:visible, input[id*="captcha" i]:visible, input[name*="captcha" i]:visible, input[name*="otp" i]:visible, iframe[src*="captcha"]:visible');
  if (await challenge.count() || /자동\s*입력\s*방지|보안\s*문자|인증\s*번호|인증\s*코드|추가\s*인증|2단계\s*인증|2차\s*인증|본인\s*확인|기기\s*등록|보안\s*인증|verification\s*code|two.factor|captcha/i.test(text)) return 'verification';
  if (/비밀번호.{0,40}(일치하지|틀[렸립]|잘못|정확|확인해)|아이디.{0,40}(일치하지|잘못|확인해)|로그인.{0,25}(실패|제한|차단)|계정.{0,20}(잠[겼금]|차단)|invalid.{0,30}(password|username)|account.{0,20}(locked|disabled)/i.test(text)) return 'invalid_credentials';
  if (new URL(page.url()).origin === COUPANG_ORIGIN && await page.locator('a[href="/tenants/cs/product/review"]').count()) return 'connected';
  if (new URL(page.url()).origin === COUPANG_AUTH_ORIGIN && await page.locator('#kc-form-login #username').isVisible() && await page.locator('#kc-form-login #password').isVisible()) return 'login';
  return 'unknown';
}

async function safeLoginForm(page) {
  if (new URL(page.url()).origin !== COUPANG_AUTH_ORIGIN) throw new Error('Unrecognized Coupang login origin');
  const form = page.locator('#kc-form-login');
  if (await form.count() !== 1) throw new Error('Unrecognized Coupang login form');
  const destination = await form.evaluate(f => ({ action: f.action, method: f.method, override: document.querySelector('#kc-login')?.getAttribute('formaction') }));
  const action = new URL(destination.override || destination.action, page.url());
  if (destination.method.toLowerCase() !== 'post' || action.origin !== COUPANG_AUTH_ORIGIN || action.pathname !== '/auth/realms/seller/login-actions/authenticate') throw new Error('Unrecognized Coupang login destination');
  for (const selector of ['#username', '#password', '#kc-login']) {
    const field = form.locator(selector);
    if (await field.count() !== 1 || !await field.isVisible() || !await field.isEnabled()) throw new Error('Unrecognized Coupang login field');
  }
}

// Normal form submission at most once. MFA/CAPTCHA is always completed by the user.
export async function loginCoupangWithCredentials(connector, credentials, { timeout = 30000 } = {}) {
  if (!credentials || credentials.method !== 'coupang') return { connected: false, reason: 'storage_error' };
  await connector.open(false);
  const deadline = Date.now() + timeout; let submitted = false;
  while (Date.now() < deadline) {
    const page = await connector.getPage(), kind = await coupangLoginScreen(page);
    if (kind === 'connected') { const status = await connector.status(true); if (status.connected) return status; if (status.networkError) return { connected: false, reason: 'connection_error' }; }
    if (kind === 'verification' || kind === 'invalid_credentials') return { connected: false, reason: kind };
    if (kind === 'login' && !submitted) {
      await safeLoginForm(page);
      await page.locator('#kc-form-login #username').fill(credentials.username);
      await page.locator('#kc-form-login #password').fill(credentials.password);
      await safeLoginForm(page); submitted = true;
      await page.locator('#kc-form-login #kc-login').click({ timeout: 5000 });
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return { connected: false, reason: 'verification' };
}
