const fs=require('node:fs');
function edit(file,fn){const old=fs.readFileSync(file,'utf8');fs.writeFileSync(file,fn(old),'utf8');}
function replace(s,a,b){if(!s.includes(a))throw new Error('Missing anchor: '+a.slice(0,100));return s.replace(a,b);}
if (!fs.readFileSync('src/server.js','utf8').includes('const sources =')) edit('src/server.js',s=>{
 s=replace(s,"import { AutoReviewSync } from './auto-sync.js';",`import { AutoReviewSync } from './auto-sync.js';
import { BaeminConnector } from './baemin.js';
import { EatsConnector } from './eats.js';
import { deliveryPlatforms, platforms, platformLabels } from '../public/platforms.js';
import { reviewPlatform } from './core.js';`);
 s=replace(s,'ablyConnector, ai =','ablyConnector, deliveryConnectors = {}, ai =');
 s=replace(s,'  const autoSync = new AutoReviewSync(store, {','  const sources = {');
 s=replace(s,"    ably: { connector: ablyConnector, service: ablyService, autoLogin: ablyAutoLogin },\n  });".replaceAll('\n',s.includes('\r\n')?'\r\n':'\n'),`    ably: { connector: ablyConnector, service: ablyService, autoLogin: ablyAutoLogin },
  };
  const deliveryQueues = { baemin: new SerialQueue(), coupangeats: new SerialQueue() };
  for (const [platform, config] of Object.entries(deliveryPlatforms)) {
    const adapter = deliveryConnectors[platform] || (config.provider === 'baemin' ? new BaeminConnector(connector, platform) : new EatsConnector(connector, platform));
    sources[platform] = { connector: adapter, service: new ReviewService(store, adapter, ai, platform, deliveryQueues[config.provider]) };
  }
  const autoSync = new AutoReviewSync(store, sources);`);
 s=replace(s,"https://d3ha2047wt6x28.cloudfront.net data:","https://d3ha2047wt6x28.cloudfront.net https://bmreview.cdn.baemin.com data:");
 s=replace(s,"const [naver, coupang, ably] = await Promise.all([connector.status(), coupangConnector.status(), ablyConnector.status()]);",`const statuses = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([id, source]) => [id, { ...await source.connector.status(), ...(source.autoLogin ? { autoLogin: source.autoLogin.publicState() } : {}) }])));
        const naver = statuses.naver;`);
 s=replace(s,"platforms: { naver, coupang: { ...coupang, autoLogin: coupangAutoLogin.publicState() }, ably: { ...ably, autoLogin: ablyAutoLogin.publicState() } }","platforms: statuses");
 s=replace(s,"        if (route === '/api/browser/open') {","        if (route === '/api/browser/open') {\n          if (deliveryPlatforms[data.platform]) return json(res, 200, await sources[data.platform].service.queue.run(() => sources[data.platform].connector.open()));");
 s=replace(s,"if (!['naver', 'coupang', 'ably', 'all'].includes(platform))","if (![...platforms, 'all'].includes(platform))");
 s=replace(s,"          if (platform === 'naver') await service.sync(period);","          if (deliveryPlatforms[platform]) await sources[platform].service.sync(period);\n          if (platform === 'naver') await service.sync(period);");
 s=replace(s,"const results = await Promise.allSettled([service.sync(period), coupangService.sync(period), ablyService.sync(period)]);","const results = await Promise.allSettled(platforms.map(id => sources[id].service.sync(period))); ");
 s=replace(s,"platform: ['naver', 'coupang', 'ably'][i]","platform: platforms[i]");
 s=replace(s,'warnings.length === 3','warnings.length === platforms.length');
 s=replace(s,"${{ naver: '네이버', coupang: '쿠팡', ably: '에이블리' }[w.platform]}","${platformLabels[w.platform]}");
 s=replace(s,"((?:(?:coupang|ably)-)?\\d+)","([a-z0-9-]{1,180})");
 s=replace(s,'const [, id, action] = match; store.review(id);','const [, id, action] = match; const review = store.review(id);\n          const selectedService = sources[reviewPlatform(review)]?.service;\n          if (!selectedService) throw new AppError(\'지원하지 않는 스토어입니다.\');');
 for(const name of ['suggest','detail','prepare','publish']) s=replace(s,`service.${name}(id`,`${name === 'detail' ? "(review.readOnly ? Promise.resolve(review) : selectedService.detail(id))" : ''}` || `selectedService.${name}(id`);
 // The read-only detail branch has a different call shape.
 s=s.replace('(review.readOnly ? Promise.resolve(review) : selectedService.detail(id))(id)', '(review.readOnly ? Promise.resolve(review) : selectedService.detail(id))');
 s=s.replace('(review.readOnly ? Promise.resolve(review) : selectedService.detail(id)))', '(review.readOnly ? Promise.resolve(review) : selectedService.detail(id)))');
 s=replace(s,"'/app.js': 'app.js',","'/app.js': 'app.js', '/platforms.js': 'platforms.js',");
 s=replace(s,'return { server, store, service,','return { server, store, sources, service,');
 return s;
});
edit('public/app.js',s=>{
 s=`import { deliveryPlatforms, platforms, replyPlatforms, platformLabels } from './platforms.js';\n`+s;
 s=replace(s,"const canReply = r => platformOf(r) === 'naver' && r.readOnly !== true;","const canReply = r => replyPlatforms.includes(platformOf(r)) && r.readOnly !== true;\nconst reviewConnected = r => r && (platformOf(r) === 'naver' ? state.connected : Boolean(state.platforms[platformOf(r)]?.connected));");
 s=s.replace(/const platformLabel = value => .*;/,"const platformLabel = value => value === 'all' ? '전체' : platformLabels[value];");
 s=s.replaceAll("['all', 'naver', 'coupang', 'ably']","['all', ...platforms]").replaceAll("['naver', 'coupang', 'ably']","platforms");
 s=s.replaceAll("'네이버 · 쿠팡 · 에이블리'","'네이버 · 쿠팡윙 · 에이블리 · 배민 · 쿠팡이츠'");
 s=replace(s,"`${platformLabel(state.platform)} · 조회 전용`","`${platformLabel(state.platform)}${readOnly ? ' · 조회 전용' : ''}`");
 s=s.replaceAll("'네이버·쿠팡의 5점 평점 기준'","'별점이 제공되는 리뷰 기준'");
 s=replace(s,"  state.platform = platform; state.filter = 'all';","  state.platform = platform; state.filter = 'all';\n  const year = $('#period').querySelector('[value=\"1y\"]'); year.disabled = platform.startsWith('baemin-'); year.hidden = year.disabled; if (year.disabled && $('#period').value === '1y') $('#period').value = '6m';");
 s=replace(s,"  const draft = state.drafts[r.id]?.text || '', generating", "  const label = platformLabel(platformOf(r));\n  const draft = state.drafts[r.id]?.text || '', generating");
 s=s.replaceAll('!state.connected || state.publishing','!reviewConnected(r) || state.publishing');
 // onEdit has an ID, not a local review variable.
 s=s.replaceAll("text.trim().length < 5 || !reviewConnected(r)","text.trim().length < 5 || !reviewConnected(state.reviews.find(r => r.id === id))");
 s=replace(s,"!status.connected || (state.drafts[state.selected]", "!reviewConnected(current()) || (state.drafts[state.selected]");
 s=s.replaceAll('네이버 답글 확인','${label} 답글 확인').replaceAll('네이버에 등록된 답글입니다.','${label}에 등록된 답글입니다.');
 s=replace(s,"'이미 답글이 등록되어 있어요. 아래 ‘${label} 답글 확인’을 누르면 내용을 가져옵니다.'","`이미 답글이 등록되어 있어요. 아래 ‘${label} 답글 확인’을 누르면 내용을 가져옵니다.`");
 s=replace(s,'async function loadDetail(id) {',"async function loadDetail(id) {\n  const label = platformLabel(platformOf(state.reviews.find(r => r.id === id))); ");
 s=s.replaceAll("'네이버에서 확인 중…'","`${label}에서 확인 중…`").replaceAll("'네이버에 등록된 답글을 확인했습니다.'","`${label}에 등록된 답글을 확인했습니다.`");
 s=replace(s,"    $('#publish-dialog').showModal();","    const label = platformLabel(platformOf(r)); $('#confirm-product').textContent = `${label} · ${r.storeName || r.store || ''} · ${r.product}`;\n    $('#confirm-publish').innerHTML = `${icon('send')}${label}에 등록`; $('#publish-notice').textContent = `아래 버튼을 누르면 이 답글이 실제 ${label} 리뷰에 등록됩니다.`;\n    $('#publish-dialog').showModal();");
 s=replace(s,'  const intent = state.intent; state.intent = null;',"  const intent = state.intent; const label = platformLabel(platformOf(state.reviews.find(r => r.id === intent.id))); state.intent = null;");
 s=s.replaceAll("'네이버에 등록 중…'","`${label}에 등록 중…`").replaceAll("'네이버에 답글이 등록되었습니다. 저장된 내용까지 확인했어요.'","`${label}에 답글이 등록되었습니다. 저장된 내용까지 확인했어요.`").replaceAll("'네이버에 등록된 답글을 다시 확인해 앱에 반영했습니다.'","`${label}에 등록된 답글을 다시 확인해 앱에 반영했습니다.`").replaceAll("`${icon('send')}네이버에 등록`","`${icon('send')}${label}에 등록`");
 s=replace(s,'function renderConnections() {',`function renderConnections() {
  for (const [platform, config] of Object.entries(deliveryPlatforms)) {
    const status = state.platforms[platform] || {}, connected = Boolean(status.connected);
    document.getElementById(platform + '-sidebar-connection').textContent = connected ? '연결됨 · 답글 가능' : '로그인 확인 필요';
    document.getElementById(platform + '-connection-dot').classList.toggle('connected', connected);
  }
  const delivery = deliveryPlatforms[state.platform];
  $('#delivery-connection-banner').hidden = !delivery;
  if (delivery) { const status = state.platforms[state.platform] || {}; $('#delivery-connection-message').textContent = status.connected ? (status.storeName || delivery.brand) + ' 리뷰를 가져오고 답글을 등록할 수 있습니다.' : status.message || delivery.providerLabel + ' 연결 창에서 로그인해 주세요.'; $('#delivery-connect-button').textContent = delivery.label + ' 연결 창 열기 ↗'; }
`);
 s=replace(s,"const tonePresets =",`for (const [platform, config] of Object.entries(deliveryPlatforms)) {
  $('.sidebar-bottom').insertAdjacentHTML('beforebegin', \`<button class="channel delivery-channel" data-platform="\${platform}" aria-label="\${config.label} 리뷰 보기"><span class="delivery-logo \${config.provider}">\${config.provider === 'baemin' ? '배' : 'E'}</span><span>\${config.label}<small id="\${platform}-sidebar-connection">연결 확인 중</small></span><span class="status-dot" id="\${platform}-connection-dot"></span></button>\`);
  $('.platform-tabs').insertAdjacentHTML('beforeend', \`<button data-platform="\${platform}">\${config.label} <span id="platform-\${platform}">0</span></button>\`);
}
$('#delivery-connect-button').addEventListener('click', () => openBrowser(state.platform));
const tonePresets =`);
 // Disconnected delivery platforms must never disable a connected Naver editor (or vice versa).
 s=replace(s,"['sidebar-connection', 'coupang-sidebar-connection', 'ably-sidebar-connection']","['sidebar-connection', 'coupang-sidebar-connection', 'ably-sidebar-connection', ...Object.keys(deliveryPlatforms).map(p => p + '-sidebar-connection')]");
 return s;
});
edit('public/index.html',s=>{
 s=s.replace('네이버·쿠팡·에이블리 리뷰를 한눈에 확인하고 네이버 답글을 관리하는','온라인 스토어와 배달 매장의 리뷰·답글을 관리하는');
 s=s.replace('세 스토어를 확인합니다.','연결된 스토어와 매장을 확인합니다.');
 s=s.replace('네이버 답글 대기','답글 대기').replace('네이버 리뷰의 답글만 집계','답글을 지원하는 매장만 집계').replace('네이버 답글 등록률','답글 등록률');
 s=s.replace('<section class="stats"', '<div id="delivery-connection-banner" class="connection-banner" hidden role="status"><p id="delivery-connection-message"></p><button id="delivery-connect-button" class="text-button">연결 창 열기 ↗</button></div>\n    <section class="stats"');
 s=s.replace('<p class="settings-note">아래 버튼을 누르면 이 답글이 실제 네이버 리뷰에 등록됩니다.</p>','<p class="settings-note" id="publish-notice">아래 버튼을 누르면 이 답글이 해당 매장 리뷰에 등록됩니다.</p>');
 return s;
});
edit('public/styles.css',s=>s+`\n/* Separate delivery shops, with the same editor and confirmation flow. */
.delivery-logo{display:grid;place-items:center;width:29px;height:29px;border-radius:8px;font-weight:800;color:#fff;flex-shrink:0}.delivery-logo.baemin{background:#219c9d}.delivery-logo.coupangeats{background:#007fac}.platform-badge[class*="baemin-"]{background:#e0f5f1;color:#157b74}.platform-badge[class*="coupangeats-"]{background:#e4f1fb;color:#16668a}.platform-bar{flex-wrap:wrap;gap:12px}.platform-tabs{flex-wrap:wrap;row-gap:6px}.sidebar{overflow-y:auto}.delivery-channel{min-height:50px}.auto-sync-platforms{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}#delivery-connection-message{flex:1}.platform-tabs button{white-space:nowrap}@media(max-width:700px){.platform-tabs{width:100%}.platform-tabs button{font-size:11px;padding:8px}.delivery-channel{display:none}#delivery-connection-banner{flex-wrap:wrap}}\n`);
