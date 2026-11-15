const sellerOrigin = 'https://sell.smartstore.naver.com';
const commerceOrigin = 'https://accounts.commerce.naver.com';
const naverOrigin = 'https://nid.naver.com';
export const REVIEW_URL = `${sellerOrigin}/#/review/search`;
export function isNaverPage(url) { try { return [sellerOrigin, commerceOrigin, naverOrigin].includes(new URL(url).origin); } catch { return false; } }

export async function loginScreen(page) {
  const origin = new URL(page.url()).origin;
  if (!isNaverPage(page.url())) return 'unknown';
  if (origin === sellerOrigin && await page.locator('span.shop').first().isVisible()) return 'connected';
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  const challenge = page.locator('input[autocomplete="one-time-code"]:visible, input[id*="captcha" i]:visible, input[name*="captcha" i]:visible, iframe[src*="captcha"]:visible');
  if (await challenge.count() || /자동\s*입력\s*방지|보안\s*문자|인증\s*번호|2단계\s*인증|본인\s*확인|기기\s*등록|로그인\s*요청.*승인/.test(text)) return 'verification';
  if (/비밀번호.{0,30}(일치하지|틀[렸립]|잘못|정확|확인해)|아이디.{0,25}(일치하지|잘못|확인해)|로그인.{0,15}(실패|제한|차단)/.test(text)) return 'invalid_credentials';
  if (origin === commerceOrigin && await page.getByPlaceholder('아이디 또는 이메일 주소', { exact: true }).isVisible()) return 'commerce';
  if (origin === naverOrigin && await page.locator('#id').isVisible() && await page.locator('#pw').isVisible()) return 'naver';
  return 'unknown';
}

async function safeForm(page, input, expectedOrigin) {
  if (new URL(page.url()).origin !== expectedOrigin || await input.count() !== 1 || !await input.isVisible()) throw new Error('Unrecognized login form');
  const action = await input.evaluate(e => e.form?.action || location.href);
  if (new URL(action).origin !== expectedOrigin) throw new Error('Unrecognized login destination');
}

// A single normal login attempt. No security setting, CAPTCHA or MFA is altered.
export async function loginWithCredentials(connector, credentials, { timeout = 30000 } = {}) {
  if (!credentials) return { connected: false, reason: 'storage_error' };
  await connector.open(false);
  let page = await connector.getPage(true);
  if (new URL(page.url()).origin === sellerOrigin) await page.goto(REVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const deadline = Date.now() + timeout;
  let submitted = false, switched = false;
  while (Date.now() < deadline) {
    const current = await connector.getPage();
    // OAuth may use a popup. Prefer it until it closes or seller login completes.
    if (!current.isClosed()) page = current;
    const kind = await loginScreen(page);
    if (kind === 'connected') {
      connector.sessionProbe = null;
      const status = await connector.status(true);
      if (status.connected) return status;
    }
    if (kind === 'verification' || kind === 'invalid_credentials') return { connected: false, reason: kind };
    if (kind === 'naver' && credentials.method === 'commerce' && !switched && !submitted) {
      switched = true; await page.goto(REVIEW_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }
    if (kind === 'commerce' && credentials.method === 'naver' && !switched && !submitted) {
      switched = true;
      await page.getByRole('button', { name: '네이버 아이디로 로그인', exact: true }).click({ timeout: 5000 });
    } else if ((kind === credentials.method) && !submitted) {
      const username = kind === 'naver' ? page.locator('#id') : page.getByPlaceholder('아이디 또는 이메일 주소', { exact: true });
      const password = kind === 'naver' ? page.locator('#pw') : page.getByPlaceholder('비밀번호', { exact: true });
      const origin = kind === 'naver' ? naverOrigin : commerceOrigin;
      await safeForm(page, username, origin); await safeForm(page, password, origin);
      await username.fill(credentials.username); await password.fill(credentials.password);
      await safeForm(page, password, origin);
      submitted = true;
      await page.getByRole('button', { name: '로그인', exact: true }).click({ timeout: 5000 });
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return { connected: false, reason: 'verification' };
}
