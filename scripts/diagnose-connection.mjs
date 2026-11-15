import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserCandidates } from '../src/browser-path.js';
import { dataDirectory } from '../src/data-directory.js';

const labels = {
  naver: '네이버', coupang: '쿠팡윙', ably: '에이블리',
  'baemin-teawest': '배민 · 티웨스트', 'baemin-besti': '배민 · 베스티',
  'coupangeats-teawest': '쿠팡이츠 · 티웨스트', 'coupangeats-besti': '쿠팡이츠 · 베스티',
};
const origins = {
  'https://sell.smartstore.naver.com': '네이버 판매자센터', 'https://nid.naver.com': '네이버 인증',
  'https://sell.account.naver.com': '네이버 판매자 인증',
  'https://wing.coupang.com': '쿠팡윙', 'https://xauth.coupang.com': '쿠팡 인증',
  'https://my.a-bly.com': '에이블리', 'https://self.baemin.com': '배민',
  'https://biz-member.baemin.com': '배민 인증', 'https://store.coupangeats.com': '쿠팡이츠',
};
const phases = new Set(['idle', 'disabled', 'connected', 'offline', 'cooldown', 'reconnecting', 'needs_attention', 'needs_verification']);
const reasons = new Set(['verification', 'invalid_credentials', 'storage_error', 'connection_error', 'interrupted', 'layout', 'unknown']);
const boolean = value => typeof value === 'boolean' ? value : null;
function authState(value = {}) {
  return { configured: boolean(value.configured), enabled: boolean(value.enabled), phase: phases.has(value.phase) ? value.phase : 'unknown', blocked: value.blocked == null ? null : reasons.has(value.blocked) ? value.blocked : 'unknown' };
}
function localEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}
async function probe(base, route, timeout, fetcher) {
  if (!base) return { result: 'invalid_local_address' };
  try {
    const response = await fetcher(base + route, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) { await response.body?.cancel(); return { result: 'http_error', httpStatus: response.status }; }
    let size = 0, chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 128 * 1024) return { result: 'response_too_large' };
      chunks.push(chunk);
    }
    return { result: 'ok', data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch (error) { return { result: ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'unavailable' }; }
}
function browserName(value) {
  const matched = typeof value === 'string' && /^(?:Chrome|Chromium|Edg|HeadlessChrome)\/\d+(?:\.\d+){0,3}$/.test(value);
  return matched ? value : 'unknown';
}

// Only explicitly selected booleans/enums enter the report. Never copy responses,
// URLs, page titles, account names, cookies, vaults, environment values, or errors.
export async function diagnoseConnection({ root, env = process.env, fetcher = fetch, timeout = 25000 } = {}) {
  const app = localEndpoint(`http://127.0.0.1:${env.PORT || 4317}`);
  const bridge = localEndpoint(env.NAVER_CDP_URL || 'http://127.0.0.1:9337');
  const [session, status, version, tabs] = await Promise.all([
    probe(app, '/api/session', Math.min(timeout, 4000), fetcher), probe(app, '/api/status', timeout, fetcher),
    probe(bridge, '/json/version', Math.min(timeout, 4000), fetcher), probe(bridge, '/json/list', Math.min(timeout, 4000), fetcher),
  ]);
  const installed = new Set();
  for (const file of browserCandidates(env)) {
    try { await access(file); installed.add(path.basename(file).toLowerCase() === 'msedge.exe' ? 'Edge' : path.basename(file).toLowerCase() === 'chrome.exe' ? 'Chrome' : '사용자 지정 브라우저'); } catch {}
  }
  let builtAt = null;
  try {
    const build = JSON.parse(await readFile(path.join(root, 'BUILD.json'), 'utf8'));
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(build.builtAt)) builtAt = build.builtAt;
  } catch {}
  const sellerTabs = {};
  if (Array.isArray(tabs.data)) for (const tab of tabs.data) {
    if (tab?.type !== 'page') continue;
    try { const name = origins[new URL(tab.url).origin]; if (name) sellerTabs[name] = (sellerTabs[name] || 0) + 1; } catch {}
  }
  const appRecognized = session.result === 'ok' && typeof session.data?.csrf === 'string' && typeof session.data?.aiConfigured === 'boolean';
  const data = status.data || {}, services = {};
  for (const id of Object.keys(labels)) {
    const value = data.platforms?.[id] || (id === 'naver' ? data : {});
    const auth = value.autoLogin || (id === 'naver' ? data.autoLogin : data.deliveryAutoLogin?.[id.split('-')[0]]);
    services[id] = { connected: boolean(value.connected), browserOpen: boolean(value.browserOpen), networkError: boolean(value.networkError), autoLogin: authState(auth) };
  }
  const report = {
    format: 'review-desk-connection-diagnostic', version: 1, collectedAt: new Date().toISOString(),
    runtime: { os: process.platform, architecture: process.arch, node: process.version, packagedAt: builtAt, installedBrowsers: [...installed] },
    app: { reachable: session.result === 'ok', recognized: appRecognized, sessionResult: session.result, statusResult: status.result, statusHttp: status.httpStatus || null },
    browser: { reachable: version.result === 'ok', versionResult: version.result, name: browserName(version.data?.Browser), tabsResult: tabs.result, sellerTabs },
    services, findings: [],
  };
  if (!appRecognized) report.findings.push('APP_UNAVAILABLE');
  if (version.result !== 'ok') report.findings.push('BROWSER_BRIDGE_UNAVAILABLE');
  if (status.result !== 'ok') report.findings.push('STATUS_UNAVAILABLE');
  if (version.result === 'ok' && tabs.result === 'ok' && !Object.keys(sellerTabs).length) report.findings.push('NO_SELLER_TABS');
  if (Object.values(services).some(s => s.autoLogin.blocked === 'storage_error')) report.findings.push('LOGIN_STORAGE_ERROR');
  if (Object.values(services).some(s => s.autoLogin.blocked === 'verification' || s.autoLogin.phase === 'needs_verification')) report.findings.push('VERIFICATION_REQUIRED');
  if (Object.values(services).some(s => s.networkError)) report.findings.push('SESSION_CHECK_FAILED');
  if (appRecognized && status.result === 'ok' && Object.values(services).some(s => s.connected === false)) report.findings.push('SOME_SERVICES_DISCONNECTED');
  return report;
}

const help = {
  APP_UNAVAILABLE: '앱 서버를 확인하지 못했습니다. 같은 폴더의 리뷰관리 실행.cmd를 실행한 뒤 다시 진단하세요.',
  BROWSER_BRIDGE_UNAVAILABLE: '앱과 연결용 브라우저의 통신을 확인하지 못했습니다. 앱의 연결 설정에서 연결 창 · 추가 인증 열기를 눌러 주세요.',
  STATUS_UNAVAILABLE: '서비스 연결 상태 요청이 완료되지 않았습니다. 이 결과를 보내 주시면 앱 연결 문제를 확인할 수 있습니다.',
  NO_SELLER_TABS: '연결용 브라우저에서 판매자센터 탭을 찾지 못했습니다. 앱의 해당 서비스 연결 설정에서 연결 창을 열어 주세요.',
  LOGIN_STORAGE_ERROR: '저장된 로그인 정보를 읽지 못했습니다. 해당 PC에서 아이디와 비밀번호를 모두 다시 저장하거나 암호화된 이전 파일을 복원하세요.',
  VERIFICATION_REQUIRED: '추가 인증 대기 상태입니다. 앱이 연 연결 창에서 인증을 완료하고 앱으로 돌아와 주세요.',
  SESSION_CHECK_FAILED: '판매자센터의 로그인 상태 확인에 실패했습니다. 인터넷이 끊겼다고 단정할 수 없으며 브라우저와 서비스별 확인이 필요합니다.',
  SOME_SERVICES_DISCONNECTED: '일부 서비스의 연결 완료가 확인되지 않았습니다. 아래 상태는 진단 시점의 결과이며 비밀번호 오류를 뜻하지는 않습니다.',
};
export function formatDiagnostic(report) {
  return ['Review Desk 연결 진단', '이 파일은 연결 상태만 포함합니다. 아이디·비밀번호·API 키·리뷰·쿠키는 포함하지 않습니다.',
    '진단은 로그인, 인증, 답글 등록이나 설정 변경을 수행하지 않습니다.', '',
    '확인 결과', ...(report.findings.length ? report.findings.map(code => `- ${help[code]}`) : ['- 앱과 브라우저에 응답이 있습니다. 화면과 다르게 보이면 앱 페이지를 새로고침한 뒤 확인하세요.']), '',
    ...Object.entries(report.services).map(([id, s]) => `${labels[id]}: ${s.connected === true ? '연결됨' : s.connected === false ? '연결 안 됨' : '확인 못 함'}`), '',
    '아래 진단 정보를 복사해 보내 주세요.', JSON.stringify(report, null, 2), ''].join('\r\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    console.log('연결 상태를 확인하고 있습니다. 최대 약 25초가 걸립니다.');
    const report = await diagnoseConnection({ root });
    const folder = dataDirectory(); await mkdir(folder, { recursive: true });
    const filename = path.join(folder, `connection-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    await writeFile(filename, '\uFEFF' + formatDiagnostic(report), 'utf8');
    console.log(formatDiagnostic(report));
    console.log(`진단 파일 저장 위치: ${filename}`);
  } catch { console.error('진단 결과를 저장하지 못했습니다. 압축을 모두 풀고 쓰기 가능한 폴더에서 다시 실행해 주세요.'); process.exitCode = 1; }
}
