import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Store, ReviewService, AppError, SerialQueue, assertReplyable } from './core.js';
import { NaverConnector } from './naver.js';
import { ReplyAI } from './ai.js';
import { AuthVault } from './auth-vault.js';
import { AutoLogin } from './auto-login.js';
import { APIKeyVault } from './api-key-vault.js';
import { CoupangConnector } from './coupang.js';
import { CoupangReviewService } from './coupang-service.js';
import { AblyConnector } from './ably.js';
import { AblyReviewService } from './ably-service.js';
import { AutoReviewSync } from './auto-sync.js';
import { BaeminConnector } from './baemin.js';
import { EatsConnector } from './eats.js';
import { DeliveryAccountConnector } from './delivery-login.js';
import { deliveryPlatforms, platforms, platformLabels, effectiveReviewPeriod } from '../public/platforms.js';
import { reviewPlatform, replyLimit } from './core.js';
import { CredentialTransfer, recoverCredentialTransfer } from './credential-transfer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function createApp({ directory = path.join(root, '.local'), connector, coupangConnector, ablyConnector, deliveryConnectors = {}, deliveryAccountConnectors = {}, deliveryVaults = {}, ai = new ReplyAI(), vault, coupangVault, ablyVault, keyVault, port = 4317, maintenanceInterval = 20000 } = {}) {
  await recoverCredentialTransfer(directory);
  const store = new Store(directory); await store.init();
  connector ||= new NaverConnector(directory);
  const service = new ReviewService(store, connector, ai);
  coupangConnector ||= new CoupangConnector(directory, connector);
  const coupangService = new CoupangReviewService(store, coupangConnector);
  ablyConnector ||= new AblyConnector(directory, connector);
  const ablyService = new AblyReviewService(store, ablyConnector);
  vault ||= new AuthVault(directory); await vault.init();
  const autoLogin = new AutoLogin(connector, vault, service.queue);
  coupangVault ||= new AuthVault(directory, undefined, { platform: 'coupang' }); await coupangVault.init();
  const coupangAutoLogin = new AutoLogin(coupangConnector, coupangVault, coupangService.queue);
  ablyVault ||= new AuthVault(directory, undefined, { platform: 'ably' }); await ablyVault.init();
  const ablyAutoLogin = new AutoLogin(ablyConnector, ablyVault, ablyService.queue);
  const sources = {
    naver: { connector, service, autoLogin },
    coupang: { connector: coupangConnector, service: coupangService, autoLogin: coupangAutoLogin },
    ably: { connector: ablyConnector, service: ablyService, autoLogin: ablyAutoLogin },
  };
  const deliveryQueues = { baemin: new SerialQueue(), coupangeats: new SerialQueue() };
  for (const [platform, config] of Object.entries(deliveryPlatforms)) {
    const adapter = deliveryConnectors[platform] || (config.provider === 'baemin' ? new BaeminConnector(connector, platform) : new EatsConnector(connector, platform));
    sources[platform] = { connector: adapter, service: new ReviewService(store, adapter, ai, platform, deliveryQueues[config.provider]) };
  }
  const deliveryAuth = {}, deliveryAccounts = {};
  for (const provider of ['baemin', 'coupangeats']) {
    const account = deliveryAccountConnectors[provider] || new DeliveryAccountConnector(connector, provider, () => {
      for (const [platform, config] of Object.entries(deliveryPlatforms)) if (config.provider === provider) {
        const adapter = sources[platform].connector; adapter.probe = null;
        if (adapter.page && !adapter.page.isClosed() && /biz-member\.baemin\.com|\/merchant\/login/.test(adapter.page.url())) adapter.page = null;
      }
    });
    const credentialVault = deliveryVaults[provider] || new AuthVault(directory, undefined, { platform: provider }); await credentialVault.init();
    deliveryAccounts[provider] = account; deliveryAuth[provider] = new AutoLogin(account, credentialVault, deliveryQueues[provider]);
    for (const [platform, config] of Object.entries(deliveryPlatforms)) if (config.provider === provider) sources[platform].autoLogin = deliveryAuth[provider];
  }
  const autoSync = new AutoReviewSync(store, sources);
  keyVault ||= new APIKeyVault(directory, ai); await keyVault.init();
  const settingsQueue = new SerialQueue();
  const credentialTransfer = new CredentialTransfer({directory,auths:{naver:autoLogin,coupang:coupangAutoLogin,ably:ablyAutoLogin,...deliveryAuth},keyVault,ai,settingsQueue});
  let transferring=false;
  const aiState = () => ({ aiConfigured: ai.configured, aiKey: keyVault.publicState() });
  const reviewState = () => ({ reviews: store.data.reviews, drafts: store.data.drafts, lastSync: store.data.lastSync, sync: store.data.sync, syncs: store.data.syncs, reviewPeriod: store.data.reviewPeriod || store.data.syncs?.naver?.period || store.data.sync?.period || '3m', autoSync: autoSync.publicState() });
  const csrf = randomBytes(32).toString('hex');
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const json = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('JSON 요청이 필요합니다.', 415);
    let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32_768) throw new AppError('요청 크기가 너무 큽니다.', 413); }
    try { return JSON.parse(text || '{}'); } catch { throw new AppError('요청 형식이 잘못되었습니다.'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://*.pstatic.net https://*.coupangcdn.com https://d3ha2047wt6x28.cloudfront.net https://bmreview.cdn.baemin.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (!origins.has(`http://${req.headers.host}`)) throw new AppError('허용되지 않은 호스트입니다.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`); const route = url.pathname;
      if (req.method === 'GET' && route === '/api/session') return json(res, 200, { csrf, settings: store.data.settings, autoSync: autoSync.publicState(), ...aiState() });
      if (req.method === 'GET' && route === '/api/status') {
        const statuses = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([id, source]) => [id, { ...await source.connector.status(), ...(source.autoLogin ? { autoLogin: source.autoLogin.publicState() } : {}) }])));
        const naver = statuses.naver;
        return json(res, 200, { ...naver, ...aiState(), autoLogin: autoLogin.publicState(), platforms: statuses, deliveryAutoLogin: Object.fromEntries(Object.entries(deliveryAuth).map(([id, auth]) => [id, auth.publicState()])) });
      }
      if (req.method === 'GET' && route === '/api/reviews') return json(res, 200, reviewState());
      if (req.method === 'POST') {
        if (!origins.has(req.headers.origin) || req.headers['x-review-token'] !== csrf) throw new AppError('이 페이지에서 다시 시도해 주세요.', 403, 'CSRF');
        const data = await body(req);
        if(route==='/api/credentials/export' || route==='/api/credentials/import') {
          if(transferring)throw new AppError('로그인 정보 이전을 처리 중입니다. 잠시 기다려 주세요.',409,'TRANSFER_BUSY');
          transferring=true;
          try {
            if(route.endsWith('/export'))return json(res,200,await credentialTransfer.export(data.password));
            const result=await credentialTransfer.restore(data.backup,data.password,data.confirmed);
            for(const provider of result.providers)void credentialTransfer.auths[provider].schedule();
            return json(res,200,{...result,...aiState()});
          } finally {data.password='';transferring=false;}
        }
        if (route === '/api/auto-sync/settings') return json(res, 200, await autoSync.save(data));
        if (route === '/api/browser/open') {
          if (deliveryPlatforms[data.platform]) {
            const provider = deliveryPlatforms[data.platform].provider, auth = deliveryAuth[provider].publicState();
            return json(res, 200, await sources[data.platform].service.queue.run(() => auth.enabled && ['needs_verification', 'needs_attention', 'reconnecting', 'cooldown'].includes(auth.phase) ? deliveryAccounts[provider].open() : sources[data.platform].connector.open()));
          }
          if (data.platform === 'coupang') return json(res, 200, await coupangService.queue.run(() => coupangConnector.open()));
          if (data.platform === 'ably') return json(res, 200, await ablyService.queue.run(() => ablyConnector.open()));
          if (data.platform && data.platform !== 'naver') throw new AppError('지원하지 않는 스토어입니다.');
          return json(res, 200, await service.queue.run(() => connector.open()));
        }
        if (route === '/api/auth/settings') { const result = await autoLogin.save(data); void autoLogin.schedule(); return json(res, 200, result); }
        if (route === '/api/auth/forget') return json(res, 200, await autoLogin.forget());
        if (route === '/api/auth/coupang/settings') { const result = await coupangAutoLogin.save(data); void coupangAutoLogin.schedule(); return json(res, 200, result); }
        if (route === '/api/auth/coupang/forget') return json(res, 200, await coupangAutoLogin.forget());
        if (route === '/api/auth/ably/settings') { const result = await ablyAutoLogin.save(data); void ablyAutoLogin.schedule(); return json(res, 200, result); }
        if (route === '/api/auth/ably/forget') return json(res, 200, await ablyAutoLogin.forget());
        const deliveryAuthRoute = route.match(/^\/api\/auth\/(baemin|coupangeats)\/(settings|forget|open)$/);
        if (deliveryAuthRoute) {
          const [, provider, action] = deliveryAuthRoute, auth = deliveryAuth[provider];
          if (action === 'settings') { const result = await auth.save(data); void auth.schedule(); return json(res, 200, result); }
          if (action === 'forget') return json(res, 200, await auth.forget());
          return json(res, 200, await deliveryQueues[provider].run(() => deliveryAccounts[provider].open()));
        }
        if (route === '/api/sync') {
          const platform = data.platform || 'naver', period = data.period || '3m';
          if (![...platforms, 'all'].includes(platform)) throw new AppError('지원하지 않는 스토어입니다.');
          if (!['1m', '3m', '6m', '1y'].includes(period)) throw new AppError('지원하지 않는 조회 기간입니다.');
          if (deliveryPlatforms[platform]) await sources[platform].service.sync(period);
          if (platform === 'naver') await service.sync(period);
          if (platform === 'coupang') await coupangService.sync(period);
          if (platform === 'ably') await ablyService.sync(period);
          if (platform === 'all') {
            await store.update(s => { s.reviewPeriod = period; });
            const results = await Promise.allSettled(platforms.map(id => sources[id].service.sync(effectiveReviewPeriod(id, period))));
            if (results[0].status === 'rejected' && results[0].reason.code === 'LOGIN_REQUIRED') void autoLogin.schedule();
            if (results[1].status === 'rejected' && results[1].reason.code === 'COUPANG_LOGIN_REQUIRED') void coupangAutoLogin.schedule();
            if (results[2].status === 'rejected' && results[2].reason.code === 'ABLY_LOGIN_REQUIRED') void ablyAutoLogin.schedule();
            const warnings = results.flatMap((r, i) => r.status === 'rejected' ? [{ platform: platforms[i], message: r.reason instanceof AppError ? r.reason.message : '리뷰를 조회하지 못했습니다. 연결 창을 확인해 주세요.' }] : []);
            if (warnings.length === platforms.length) throw new AppError(warnings.map(w => `${platformLabels[w.platform]}: ${w.message}`).join(' '), 502, 'SYNC_FAILED');
            return json(res, 200, { ...reviewState(), warnings });
          }
          return json(res, 200, { ...reviewState(), warnings: [] });
        }
        if (route === '/api/settings') return json(res, 200, await settingsQueue.run(async () => {
          const settings = { ...store.data.settings };
          if (data.platform !== undefined && !deliveryPlatforms[data.platform]) throw new AppError('지원하지 않는 매장입니다.');
          const delivery = data.platform ? { tone:'따뜻하고 정중하게', guidance:'', ...settings.delivery?.[data.platform] } : null;
          for (const [field, max] of [['brand', 80], ['tone', 200], ['guidance', 2000], ['model', 100]]) {
            if (data[field] !== undefined) { if (typeof data[field] !== 'string' || data[field].length > max) throw new AppError('설정 내용의 길이를 확인해 주세요.'); if (delivery && ['tone','guidance'].includes(field)) delivery[field] = data[field].trim(); else if (!(delivery && field === 'brand')) settings[field] = data[field].trim(); }
          }
          if (delivery) settings.delivery = { ...settings.delivery, [data.platform]: delivery };
          if (!settings.brand || !/^[a-zA-Z0-9._-]+$/.test(settings.model)) throw new AppError('브랜드명과 모델명을 확인해 주세요.');
          if (data.apiKey !== undefined && typeof data.apiKey !== 'string') throw new AppError('OpenAI API 키 형식을 확인해 주세요.');
          if (data.apiKey && data.disconnectAI === true) throw new AppError('API 키 저장과 삭제는 따로 진행해 주세요.');
          if (data.disconnectAI === true) await keyVault.forget();
          else if (data.apiKey) await keyVault.save(data.apiKey);
          else if (ai.configured && !keyVault.publicState().saved && ai.key) await keyVault.save(ai.key);
          await store.update(s => { s.settings = settings; });
          return { settings: store.data.settings, ...aiState() };
        }));
        const match = route.match(/^\/api\/reviews\/([a-z0-9-]{1,180})\/(draft|suggest|detail|prepare|publish)$/);
        if (match) {
          const [, id, action] = match; const review = store.review(id);
          const selectedService = sources[reviewPlatform(review)]?.service;
          if (!selectedService) throw new AppError('지원하지 않는 스토어입니다.');
          if (action !== 'detail') assertReplyable(store.review(id));
          if (action === 'draft') {
            if (typeof data.text !== 'string' || data.text.length > replyLimit(review)) throw new AppError(`초안은 ${replyLimit(review)}자 이하로 작성해 주세요.`);
            if (store.review(id).hasReply) throw new AppError('이미 등록된 리뷰입니다.', 409);
            await store.update(s => { s.drafts[id] = { text: data.text, savedAt: new Date().toISOString() }; }); return json(res, 200, { saved: true });
          }
          if (action === 'suggest') return json(res, 200, await selectedService.suggest(id, data.tone));
          if (action === 'detail') return json(res, 200, review.readOnly ? review : await selectedService.detail(id));
          if (action === 'prepare') return json(res, 200, selectedService.prepare(id, data.text, data.fingerprint, randomBytes(32).toString('hex')));
          if (action === 'publish') return json(res, 200, await selectedService.publish(id, data.token));
        }
        throw new AppError('요청한 기능을 찾을 수 없습니다.', 404);
      }
      const files = { '/': 'index.html', '/app.js': 'app.js', '/platforms.js': 'platforms.js', '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg' };
      if (req.method !== 'GET' || !files[route]) throw new AppError('페이지를 찾을 수 없습니다.', 404);
      const contents = await readFile(path.join(root, 'public', files[route]));
      const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': `${types[path.extname(files[route])]}; charset=utf-8`, 'Cache-Control': 'no-cache' }); res.end(contents);
    } catch (error) {
      if (error.code === 'LOGIN_REQUIRED') void autoLogin.schedule();
      if (error.code === 'COUPANG_LOGIN_REQUIRED') void coupangAutoLogin.schedule();
      if (error.code === 'ABLY_LOGIN_REQUIRED') void ablyAutoLogin.schedule();
      if (error.code === 'DELIVERY_LOGIN_REQUIRED') for (const auth of Object.values(deliveryAuth)) void auth.schedule();
      if (error instanceof AppError) json(res, error.status, { error: error.message, code: error.code });
      else { console.error(`[${new Date().toISOString()}] ${error.name}: request failed`); json(res, 500, { error: '작업을 완료하지 못했습니다. 스토어 연결 상태를 확인하고 다시 시도해 주세요.', code: 'INTERNAL_ERROR' }); }
    }
  });
  server.requestTimeout = 120_000;
  let maintenance;
  const maintain = () => { for (const auth of [autoLogin, coupangAutoLogin, ablyAutoLogin, ...Object.values(deliveryAuth)]) void auth.schedule(); void autoSync.tick(); };
  server.on('listening', () => { if (maintenanceInterval) { maintain(); maintenance = setInterval(maintain, maintenanceInterval); maintenance.unref(); } });
  server.on('close', () => { clearInterval(maintenance); autoSync.stop(); });
  return { server, store, sources, service, coupangService, ablyService, csrf, autoLogin, coupangAutoLogin, ablyAutoLogin, deliveryAuth, deliveryAccounts, autoSync };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317); const { server } = await createApp({ port });
  server.listen(port, '127.0.0.1', () => console.log(`Review Desk ready: http://127.0.0.1:${port}`));
}
