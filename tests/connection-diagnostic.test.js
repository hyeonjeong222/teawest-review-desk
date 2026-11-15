import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { diagnoseConnection, formatDiagnostic } from '../scripts/diagnose-connection.mjs';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = String(server.address().port);
  return { PORT: port, NAVER_CDP_URL: `http://127.0.0.1:${port}` };
}

test('connection report keeps only status facts and never writes credentials, titles, URLs, reviews, or raw errors', async t => {
  const requests = [], secret = 'PRIVATE-FIXTURE-DO-NOT-EXPORT';
  const env = await fixture(t, (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    const routes = {
      '/api/session': { csrf: secret, aiConfigured: true, settings: { apiKey: secret, brand: secret } },
      '/api/status': { connected: true, autoLogin: { configured: true, enabled: true, phase: 'connected', username: secret, password: secret },
        platforms: { naver: { connected: true, browserOpen: true, store: secret }, coupang: { connected: false, networkError: true, message: secret, autoLogin: { configured: true, enabled: true, phase: secret, blocked: secret } } },
        reviews: [{ content: secret }], aiKey: { key: secret }, cookie: secret },
      '/json/version': { Browser: 'Chrome/157.0.0.0', webSocketDebuggerUrl: `ws://localhost/${secret}` },
      '/json/list': [{ type: 'page', title: secret, url: `https://sell.smartstore.naver.com/${secret}?token=${secret}`, webSocketDebuggerUrl: secret }, { type: 'page', url: `https://example.invalid/${secret}` }],
    };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(routes[req.url]));
  });
  const report = await diagnoseConnection({ root: 'nonexistent-diagnostic-test-directory', env });
  const rendered = formatDiagnostic(report);
  assert.equal(rendered.includes(secret), false);
  assert.equal(rendered.includes('https://'), false);
  assert.equal(report.app.recognized, true);
  assert.equal(report.browser.name, 'Chrome/157.0.0.0');
  assert.deepEqual(report.browser.sellerTabs, { '네이버 판매자센터': 1 });
  assert.equal(report.services.naver.connected, true);
  assert.equal(report.services.coupang.autoLogin.phase, 'unknown');
  assert.equal(report.services.coupang.autoLogin.blocked, 'unknown');
  assert.ok(report.findings.includes('SESSION_CHECK_FAILED'));
  assert.equal(requests.length, 4);
  assert.ok(requests.every(r => r.method === 'GET' && r.authorization === undefined));
});

test('diagnostic endpoints are strictly loopback and redirects never contact another host', async t => {
  let calls = 0;
  const report = await diagnoseConnection({ env: { PORT: '4317@external.invalid', NAVER_CDP_URL: 'http://192.168.1.2:9337' }, fetcher: async () => { calls++; throw new Error('Must not fetch'); } });
  assert.equal(calls, 0); assert.equal(report.app.statusResult, 'invalid_local_address');
  assert.equal(report.browser.versionResult, 'invalid_local_address');
  const env = await fixture(t, (_req, res) => { res.writeHead(302, { location: 'http://external.invalid/private-token' }).end(); });
  const redirected = await diagnoseConnection({ env });
  assert.equal(redirected.app.statusResult, 'unavailable');
  assert.equal(formatDiagnostic(redirected).includes('private-token'), false);
});

test('a stalled app status has a bounded timeout while browser and session results remain usable', async t => {
  const env = await fixture(t, (req, res) => {
    if (req.url === '/api/status') return;
    const data = req.url === '/api/session' ? { csrf: 'test', aiConfigured: false } : req.url === '/json/list' ? [] : { Browser: 'Chrome/157.0.0.0' };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
  });
  const report = await diagnoseConnection({ env, timeout: 500 });
  assert.equal(report.app.recognized, true); assert.equal(report.app.statusResult, 'timeout');
  assert.equal(report.browser.reachable, true);
  assert.equal(report.services.naver.connected, null);
  assert.ok(report.findings.includes('STATUS_UNAVAILABLE'));
  assert.ok(report.findings.includes('NO_SELLER_TABS'));
});
