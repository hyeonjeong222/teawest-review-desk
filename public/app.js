import { deliveryPlatforms, platforms, replyPlatforms, platformLabels, effectiveReviewPeriod } from './platforms.js';
const icons = {
  inbox: '<path d="M4 4h16l2 10v6H2v-6L4 4Z"/><path d="M2 14h6l2 3h4l2-3h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-5-5L4 14v6Z"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  messages: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V9a7 7 0 0 1 7-7h5a7 7 0 0 1 7 7v2Z"/><path d="M7 8h9M7 12h6"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4"/>',
  settings: '<path d="m10 3-.7 2.3-2 .9L5 5.8 3 9l1.7 1.8v2.4L3 15l2 3.2 2.3-.4 2 .9.7 2.3h4l.7-2.3 2-.9 2.3.4 2-3.2-1.7-1.8v-2.4L21 9l-2-3.2-2.3.4-2-.9L14 3h-4Z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 10a8 8 0 0 0-14-5L3 8M3 3v5h5M4 14a8 8 0 0 0 14 5l3-3M21 21v-5h-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  sort: '<path d="M8 4v16m-4-4 4 4 4-4M16 20V4m-4 4 4-4 4 4"/>',
  link: '<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(0 -1) scale(.92)"/>',
  send: '<path d="m22 2-7 20-4-9-9-4L22 2ZM11 13 22 2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  bag: '<path d="M5 7h14l1 14H4L5 7Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  external: '<path d="M14 3h7v7M10 14 21 3M11 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.1"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.messages}</svg>`;
const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { reviews: [], drafts: {}, filter: 'all', query: '', rating: 'all', selected: null, settings: {}, autoLogin: {}, csrf: '', aiConfigured: false, connected: false, syncing: false, generating: new Set(), suggestions: new Map(), edits: new Map(), saving: new Map(), saveTimers: new Map(), intent: null, publishing: false };
const replyTones = new Map();
state.platform = 'naver'; state.platforms = {}; state.syncs = {};
state.syncRequest = null; state.syncErrors = {};
const periodLabels = { '1m': '최근 1개월', '3m': '최근 3개월', '6m': '최근 6개월', '1y': '최근 1년' };
const syncInfo = platform => state.syncs[platform] || (platform === 'naver' ? state.sync : null);
const selectedPeriod = () => state.syncRequest?.period || state.reviewPeriod || syncInfo('naver')?.period || '3m';
const waitingForPeriod = platform => Boolean(state.syncRequest && syncInfo(platform)?.lastSync === state.syncRequest.baselines[platform]);
const failedPeriod = platform => state.syncErrors[platform] && state.syncErrors[platform].lastSync === syncInfo(platform)?.lastSync;
const platformOf = r => r?.platform || 'naver';
const canReply = r => replyPlatforms.includes(platformOf(r)) && r.readOnly !== true;
const replyLimit = r => platformOf(r).startsWith('coupangeats-') ? 300 : 1000;
const reviewConnected = r => r && (platformOf(r) === 'naver' ? state.connected : Boolean(state.platforms[platformOf(r)]?.connected));
const platformLabel = value => value === 'all' ? '전체' : platformLabels[value];
const storePreferences = platform => deliveryPlatforms[platform] ? { tone: '따뜻하고 정중하게', guidance: '', ...state.settings.delivery?.[platform], brand: deliveryPlatforms[platform].brand } : state.settings;
const platformReviews = () => state.reviews.filter(r => platformOf(r) === state.platform);
let reviewRevision = 0;
for (const [platform, config] of Object.entries(deliveryPlatforms)) {
  $('.sidebar-bottom').insertAdjacentHTML('beforebegin', `<button class="channel delivery-channel" data-platform="${platform}" aria-label="${config.label} 리뷰 보기"><span class="delivery-logo ${config.provider}">${config.provider === 'baemin' ? '배' : 'E'}</span><span>${config.label}<small id="${platform}-sidebar-connection">연결 확인 중</small></span><span class="status-dot" id="${platform}-connection-dot"></span></button>`);
  $('.platform-tabs').insertAdjacentHTML('beforeend', `<button data-platform="${platform}">${config.label} <span id="platform-${platform}">0</span></button>`);
}
$('#delivery-connect-button').addEventListener('click', () => openBrowser(state.platform));
const connectionProviderLabel = provider => provider === 'baemin' ? '배달의민족' : '쿠팡이츠';
state.deliveryAutoLogin = {};
function providerPlatform(provider) {
  return deliveryPlatforms[state.platform]?.provider === provider ? state.platform : Object.keys(deliveryPlatforms).find(p => deliveryPlatforms[p].provider === provider);
}
function renderDeliverySettings() {
  const platform = $('#delivery-settings-store').value, provider = $('#delivery-settings-dialog').dataset.provider, status = state.platforms[platform] || {}, auth = state.deliveryAutoLogin[provider] || {};
  $('#delivery-settings-status').textContent = deliveryAuthMessage(provider, status, auth);
  $('#delivery-auth-forget').disabled = !auth.configured || Boolean(state.savingDeliveryAuth);
  $('#delivery-auth-save').disabled = Boolean(state.savingDeliveryAuth);
}
function deliveryAuthMessage(provider, status, auth) {
  if (auth.phase === 'reconnecting') return '저장된 로그인 정보로 다시 연결하고 있습니다.';
  if (auth.blocked === 'verification' || auth.phase === 'needs_verification') return '추가 인증이 필요합니다. 연결 창에서 인증·보안 문자 등을 직접 완료하면 자동으로 다시 확인합니다.';
  if (auth.blocked === 'invalid_credentials') return '아이디 또는 비밀번호가 올바르지 않습니다. 새 비밀번호를 입력하고 저장해 주세요.';
  if (auth.blocked === 'storage_error') return '저장된 정보를 읽지 못했습니다. 아이디와 비밀번호를 다시 입력해 주세요.';
  if (auth.blocked) return '자동 로그인을 완료하지 못했습니다. 연결 창을 확인한 뒤 설정을 저장하면 다시 시도합니다.';
  if (auth.phase === 'offline' || status.networkError) return '인터넷 또는 판매자센터 연결을 확인해 주세요. 기존 리뷰와 초안은 유지됩니다.';
  if (auth.phase === 'cooldown') return '로그인이 반복해서 만료되어 잠시 후 다시 연결합니다. 연결 창에서 직접 로그인할 수도 있습니다.';
  if (status.connected) return `${connectionProviderLabel(provider)} 연결됨${auth.enabled ? ' · 자동 로그인 켜짐' : ''}${status.storeName ? ' · ' + status.storeName : ''}`;
  return auth.enabled ? '자동 연결을 확인하고 있습니다. 추가 인증이 필요하면 알려드립니다.' : '아이디와 비밀번호를 저장해 자동 로그인을 켜거나 연결 창에서 직접 로그인해 주세요.';
}
async function openDeliverySettings(provider) {
  if (state.savingDeliveryAuth) return;
  $('#delivery-settings-dialog').dataset.provider = provider;
  $('#delivery-settings-title').textContent = `${connectionProviderLabel(provider)} 연결 설정`;
  $('#delivery-settings-store').innerHTML = Object.entries(deliveryPlatforms).filter(([, config]) => config.provider === provider).map(([id, config]) => `<option value="${id}">${esc(config.brand)}</option>`).join('');
  $('#delivery-settings-store').value = providerPlatform(provider); $('#delivery-settings-message').textContent = '';
  $('#delivery-auth-username').value = ''; $('#delivery-auth-password').value = '';
  await refreshStatus(); if ($('#delivery-settings-dialog').dataset.provider !== provider) return;
  const auth = state.deliveryAutoLogin[provider] || {};
  $('#delivery-auth-enabled').checked = auth.configured ? Boolean(auth.enabled) : true;
  $('#delivery-auth-username-label').textContent = provider === 'baemin' ? '배민비즈회원 아이디' : '쿠팡이츠 사장님 아이디';
  $('#delivery-auth-username').placeholder = auth.configured ? '저장된 아이디 사용 · 계정 변경 시 입력' : '처음 연결할 때 입력';
  $('#delivery-auth-password').placeholder = auth.configured ? '변경한 새 비밀번호 입력 · 비우면 유지' : '처음 연결할 때 입력';
  renderDeliverySettings(); $('#delivery-settings-dialog').showModal();
}
$('#baemin-auth-open').addEventListener('click', () => openDeliverySettings('baemin'));
$('#eats-auth-open').addEventListener('click', () => openDeliverySettings('coupangeats'));
$('#delivery-settings-store').addEventListener('change', renderDeliverySettings);
$('#delivery-settings-browser').addEventListener('click', async () => {
  const button = $('#delivery-settings-browser'); button.disabled = true;
  const provider = $('#delivery-settings-dialog').dataset.provider;
  try { await api(`/api/auth/${provider}/open`, {}); await refreshStatus(); $('#delivery-settings-message').textContent = '추가 인증이 나오면 열린 연결 창에서 직접 완료해 주세요.'; }
  catch (error) { $('#delivery-settings-message').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#delivery-auth-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.savingDeliveryAuth) return;
  const provider = $('#delivery-settings-dialog').dataset.provider;
  state.savingDeliveryAuth = true; renderDeliverySettings();
  try {
    state.deliveryAutoLogin[provider] = await api(`/api/auth/${provider}/settings`, { enabled: $('#delivery-auth-enabled').checked, method: provider, username: $('#delivery-auth-username').value, password: $('#delivery-auth-password').value });
    $('#delivery-auth-username').value = ''; $('#delivery-auth-password').value = ''; $('#delivery-settings-dialog').close();
    await refreshStatus(); toast(`${connectionProviderLabel(provider)} 로그인 정보를 저장했습니다. 다음 로그인부터 적용됩니다.`);
  } catch (error) { $('#delivery-settings-message').textContent = error.message; }
  finally { state.savingDeliveryAuth = false; renderDeliverySettings(); }
});
$('#delivery-auth-forget').addEventListener('click', async () => {
  if (state.savingDeliveryAuth) return; const provider = $('#delivery-settings-dialog').dataset.provider;
  state.savingDeliveryAuth = true; renderDeliverySettings();
  try { state.deliveryAutoLogin[provider] = await api(`/api/auth/${provider}/forget`, {}); $('#delivery-auth-username').value = ''; $('#delivery-auth-password').value = ''; $('#delivery-auth-enabled').checked = false; $('#delivery-settings-message').textContent = '이 서비스의 저장된 로그인 정보를 삭제했습니다. 현재 로그인과 리뷰는 유지됩니다.'; await refreshStatus(); }
  catch (error) { $('#delivery-settings-message').textContent = error.message; }
  finally { state.savingDeliveryAuth = false; renderDeliverySettings(); }
});
$('#delivery-settings-dialog').addEventListener('close', () => { $('#delivery-auth-username').value = ''; $('#delivery-auth-password').value = ''; });
for (const button of document.querySelectorAll('[data-delivery-center]')) button.addEventListener('click', () => openBrowser(providerPlatform(button.dataset.deliveryCenter)));
$('#naver-open').addEventListener('click', () => openBrowser('naver'));
const tonePresets = ['따뜻하고 정중하게', '친근하고 밝게', '간결하고 담백하게', '공감하며 차분하게', '격식 있고 정중하게'];
for (const el of document.querySelectorAll('[data-icon]')) el.replaceWith(document.createRange().createContextualFragment(icon(el.dataset.icon)));
async function api(route, data) {
  const res = await fetch(route, data === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': state.csrf }, body: JSON.stringify(data) });
  const result = await res.json(); if (!res.ok) { const error = new Error(result.error || '요청을 완료하지 못했습니다.'); error.code = result.code; throw error; } return result;
}
let toastTimer;
function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, error ? 10000 : 4500); }
function stars(n) { return `<span class="stars">${'★'.repeat(Math.max(0, Math.min(5, n)))}<span class="off">${'★'.repeat(Math.max(0, 5 - n))}</span><span class="rating-number">${n}.0</span></span>`; }
function ratingMarkup(r) { return Number.isFinite(r.rating) ? stars(r.rating) : `<span class="satisfaction ${r.satisfaction === true ? 'positive' : r.satisfaction === false ? 'negative' : ''}">${r.satisfaction === true ? '만족' : r.satisfaction === false ? '불만족' : '만족도 정보 없음'}</span>`; }
function matchesRating(r) {
  if (state.rating === 'all') return true;
  if (state.rating === 'satisfied' || state.rating === 'unsatisfied') return platformOf(r) === 'ably' && r.satisfaction === (state.rating === 'satisfied');
  return Number.isFinite(r.rating) && (state.rating === 'low' ? r.rating <= 3 : r.rating === Number(state.rating));
}
function reviewState(r) { return !canReply(r) ? 'readonly' : r.hasReply ? 'replied' : r.replyAllowed === false ? 'expired' : state.drafts[r.id]?.text?.trim() ? 'draft' : 'pending'; }
function badge(r) { const status = reviewState(r); return `<span class="badge ${status}">${{ pending: '답글 대기', draft: '작성 중', replied: '등록 완료', readonly: '조회 전용', expired: '등록 기간 종료' }[status]}</span>`; }
function current() { return state.reviews.find(r => r.id === state.selected); }
function filtered() {
  return platformReviews().filter(r => (state.filter === 'all' || (state.filter === 'pending' ? canReply(r) && r.replyAllowed !== false && !r.hasReply : reviewState(r) === state.filter)) && matchesRating(r) && `${r.content} ${r.product} ${r.author}`.toLowerCase().includes(state.query.toLowerCase()));
}
function renderPeriodControls() {
  const platform = state.platform, info = syncInfo(platform), request = state.syncRequest;
  const period = selectedPeriod(); $('#period').value = period;
  $('#period').disabled = state.syncing || state.publishing;
  const applied = info ? `${platformLabel(platform)} · ${periodLabels[info.period] || '조회 기간'} · ${platformReviews().length}개` : `${platformLabel(platform)} · 가져온 리뷰 없음`;
  const limit = period === '1y' && request ? ' 배민은 기간을 나누어 1년치를 조회합니다.' : '';
  $('#period-status').textContent = request
    ? `전체 스토어 ${periodLabels[period]} 조회 중 (${platforms.filter(p => !waitingForPeriod(p)).length}/${platforms.length}) · 현재 목록: ${applied}.${limit}`
    : failedPeriod(platform) ? `조회 실패: ${state.syncErrors[platform].message} · 기존 목록: ${applied}.${limit}`
    : info?.period !== effectiveReviewPeriod(platform, period) ? `전체 스토어 ${periodLabels[period]} 선택 · 이 매장은 조회가 필요합니다. 기존 목록: ${applied}.${limit}`
    : applied;
}
function renderStats() {
  renderPeriodControls();
  const all = platformReviews(), replyable = all.filter(r => canReply(r) && (r.hasReply || r.replyAllowed !== false)), replied = replyable.filter(r => r.hasReply).length, pending = replyable.length - replied, drafts = replyable.filter(r => reviewState(r) === 'draft').length;
  const rated = all.filter(r => Number.isFinite(r.rating)), avg = rated.length ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : 0;
  $('#stat-total').textContent = all.length; $('#stat-pending').textContent = pending; $('#stat-rate').textContent = replyable.length ? Math.round(100 * replied / replyable.length) : '—';
  $('#rate-bar').style.width = `${replyable.length ? 100 * replied / replyable.length : 0}%`;
  const isAbly = state.platform === 'ably', satisfied = all.filter(r => platformOf(r) === 'ably' && r.satisfaction === true).length, assessed = all.filter(r => platformOf(r) === 'ably' && typeof r.satisfaction === 'boolean').length;
  $('#stat-rating-label').textContent = isAbly ? '만족 비율' : '평균 평점'; $('#stat-rating-unit').textContent = isAbly ? '%' : '/ 5'; $('#stat-rating-icon').textContent = isAbly ? '♡' : '★';
  $('#stat-rating').textContent = isAbly ? assessed ? Math.round(100 * satisfied / assessed) : '—' : rated.length ? avg.toFixed(1) : '—';
  $('#stat-stars').textContent = isAbly ? `만족 ${satisfied}개 · 불만족 ${assessed - satisfied}개` : '★'.repeat(Math.round(avg)) + '☆'.repeat(5 - Math.round(avg));
  $('#stat-stars').classList.toggle('rating-caption', isAbly);
  for (const option of $('#rating-filter').options) { const satisfaction = ['satisfied', 'unsatisfied'].includes(option.value); option.hidden = option.value !== 'all' && (isAbly ? !satisfaction : satisfaction); option.disabled = option.hidden; }
  for (const [key, value] of Object.entries({ pending, draft: drafts, replied })) $(`#nav-${key}`).textContent = value;
  for (const platform of platforms) {
    const info = syncInfo(platform), period = effectiveReviewPeriod(platform, selectedPeriod());
    const text = waitingForPeriod(platform) ? '조회 중' : failedPeriod(platform) ? '조회 실패' : info?.period !== period ? '조회 필요' : String(state.reviews.filter(r => platformOf(r) === platform).length);
    const count = $(`#platform-${platform}`); count.textContent = text;
    count.parentElement.title = `${platformLabel(platform)} · ${periodLabels[period]} · ${text}${/^\d+$/.test(text) ? '개' : ''}`;
  }
  for (const button of document.querySelectorAll('[data-platform]')) { const active = button.dataset.platform === state.platform; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
  const readOnly = ['coupang', 'ably'].includes(state.platform);
  for (const stat of document.querySelectorAll('[data-reply-stat]')) stat.hidden = readOnly;
  $('.stats').classList.toggle('coupang-view', readOnly);
  for (const button of document.querySelectorAll('[data-filter]')) button.disabled = readOnly && button.dataset.filter !== 'all';
  $('.filter-tabs').hidden = readOnly;
  $('#platform-heading').textContent = `${platformLabel(state.platform)} 리뷰`;
  $('#list-footer-platform').textContent = state.platform === 'naver' ? '네이버 스마트스토어' : `${platformLabel(state.platform)}${readOnly ? ' · 조회 전용' : ''}`;
  const info = state.syncs?.[state.platform] || (state.platform === 'naver' ? state.sync : null), syncedAt = info?.lastSync;
  $('#sync-meta').textContent = syncedAt ? `마지막 동기화 ${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(syncedAt))}` : `${platformLabel(state.platform)} 리뷰를 가져와 주세요`;
  $('#stat-period').textContent = info?.from ? `${info.from} — ${info.to}` : '조회 기간 내 리뷰';
}
function selectPlatform(platform) {
  if (!platforms.includes(platform)) return;
  if (state.platform !== platform) { state.query = ''; state.rating = 'all'; $('#search').value = ''; $('#rating-filter').value = 'all'; }
  state.platform = platform; state.filter = 'all';
  const rows = filtered(); if (!rows.some(r => r.id === state.selected)) state.selected = rows[0]?.id || null;
  renderStats(); renderConnections(); renderList(); renderDetail();
}
function renderList() {
  const rows = filtered(); $('#list-count').textContent = rows.length; $('#list-footer-count').textContent = `${rows.length}개 리뷰`;
  for (const button of document.querySelectorAll('[data-filter]')) button.classList.toggle('active', button.dataset.filter === state.filter);
  if (!rows.length) { $('#review-list').innerHTML = `<div class="empty">${icon('inbox')}<h3>${platformReviews().length ? '조건에 맞는 리뷰가 없어요' : '아직 가져온 리뷰가 없어요'}</h3><p>${platformReviews().length ? '검색어나 필터를 바꿔보세요.' : '스토어에 로그인한 뒤<br>리뷰 가져오기를 눌러 주세요.'}</p></div>`; return; }
  $('#review-list').innerHTML = rows.map((r, i) => `<button class="review-card ${r.id === state.selected ? 'selected' : ''}" data-review="${esc(r.id)}" aria-pressed="${r.id === state.selected}"><div class="card-top"><span class="card-person"><span class="person-icon tone-${i % 3}">${esc(r.author.slice(0, 1))}</span>${esc(r.author)}<span class="card-date">${esc(r.date.slice(0, 11))}</span></span>${badge(r)}</div><div class="card-rating">${ratingMarkup(r)}</div><p class="card-copy">${esc(r.content || '텍스트 없는 리뷰')}</p><div class="card-bottom"><span class="platform-badge ${platformOf(r)}">${platformLabel(platformOf(r))}</span><span class="card-product">${esc(r.product)}</span>${r.media?.length ? `<span class="media-indicator">${icon('image')}${r.media.length}</span>` : ''}</div></button>`).join('');
}
function renderReadOnlyDetail(r) {
  const platform = platformOf(r), label = platformLabel(platform), seller = platform === 'coupang' ? '쿠팡윙' : '에이블리 판매자센터';
  $('#detail-panel').innerHTML = `<div class="detail-top"><h2>${label} 리뷰 상세</h2><span class="badge readonly">조회 전용</span></div><div class="detail-content"><div class="product-info"><span class="product-icon">${icon('bag')}</span><div><small>구매한 상품</small>${r.productUrl ? `<a href="${esc(r.productUrl)}" target="_blank" rel="noreferrer">${esc(r.product)} ${icon('external')}</a>` : `<span class="product-name">${esc(r.product)}</span>`}${r.option ? `<small>${esc(r.option)}</small>` : ''}</div></div><div class="review-meta"><span class="card-person">${esc(r.author)}<span class="card-date">${esc(r.date)}</span></span><span class="detail-id">#${esc(r.sourceId || r.id)}</span></div><div class="detail-rating">${ratingMarkup(r)}</div><p class="original-review">${esc(r.content || '텍스트 없는 리뷰입니다.')}</p>${r.media?.length ? `<div class="media-row">${r.media.map(url => `<a href="${esc(url)}" target="_blank" rel="noreferrer"><img src="${esc(url)}" alt="고객이 첨부한 리뷰 사진" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>` : ''}</div><div class="readonly-note">${icon('info')}<div><strong>${label} 리뷰는 확인만 할 수 있어요.</strong><p>답글 작성·추천·등록 기능은 제공하지 않습니다.</p></div></div><div class="reply-actions"><button id="${platform}-detail-open" class="text-button">${seller} 리뷰 목록 열기 ${icon('external')}</button></div>`;
  $(`#${platform}-detail-open`).addEventListener('click', () => openBrowser(platform));
}
function renderToneControls(id, disabled) {
  const choice = replyTones.get(id) || { value: 'default', custom: '' };
  const options = [['default', `브랜드 기본 · ${storePreferences(platformOf(state.reviews.find(r => r.id === id))).tone || '따뜻하고 정중하게'}`], ...tonePresets.map(tone => [tone, tone]), ['custom', '직접 설정하기']];
  $('#reply-editor')?.closest('.editor-wrap').insertAdjacentHTML('beforebegin', `<div class="tone-controls"><label for="reply-tone">이번 추천의 말투</label><select id="reply-tone" ${disabled ? 'disabled' : ''}>${options.map(([value, label]) => `<option value="${esc(value)}" ${choice.value === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select><div id="custom-tone-wrap" ${choice.value === 'custom' ? '' : 'hidden'}><label for="reply-tone-custom">원하는 말투 직접 입력</label><textarea id="reply-tone-custom" maxlength="200" rows="2" placeholder="예: 단골 고객에게 말하듯 다정하게, 이모지 없이 짧게" ${disabled ? 'disabled' : ''}>${esc(choice.custom)}</textarea></div><p>이 리뷰의 추천에만 적용됩니다. 말투를 바꾼 뒤 다시 추천받을 수 있어요.</p></div>`);
  $('#reply-tone')?.addEventListener('change', event => {
    const next = { ...choice, ...replyTones.get(id), value: event.target.value }; replyTones.set(id, next);
    $('#custom-tone-wrap').hidden = next.value !== 'custom';
    if (next.value === 'custom') $('#reply-tone-custom').focus();
  });
  $('#reply-tone-custom')?.addEventListener('input', event => replyTones.set(id, { value: 'custom', custom: event.target.value }));
}
function renderDetail() {
  const r = current();
  if (!r) { $('#detail-panel').innerHTML = `<div class="empty detail-empty">${icon('messages')}<h3>고객의 이야기를 선택해 주세요</h3><p>리뷰를 선택하면 내용을 확인하고<br>추천 답글을 받아볼 수 있어요.</p></div>`; return; }
  if (!canReply(r)) { renderReadOnlyDetail(r); return; }
  const label = platformLabel(platformOf(r)), maxLength = replyLimit(r);
  const draft = state.drafts[r.id]?.text || '', generating = state.generating.has(r.id), suggestion = state.suggestions.get(r.id);
  $('#detail-panel').innerHTML = `<div class="detail-top"><h2>리뷰 상세</h2><span class="detail-id">#${r.id}</span></div><div class="detail-content"><div class="product-info"><span class="product-icon">${icon('bag')}</span><div><small>구매한 상품</small><a href="${esc(r.productUrl)}" target="_blank" rel="noreferrer">${esc(r.product)} ${icon('external')}</a>${r.option ? `<small>${esc(r.option)}</small>` : ''}</div></div><div class="review-meta"><span class="card-person">${esc(r.author)}<span class="card-date">${esc(r.date)}</span></span>${badge(r)}</div><div class="detail-rating">${ratingMarkup(r)}</div><p class="original-review">${esc(r.content || '텍스트 없는 리뷰입니다.')}</p>${r.media?.length ? `<div class="media-row">${r.media.map(url => `<a href="${esc(url)}" target="_blank" rel="noreferrer"><img src="${esc(url)}" alt="고객이 첨부한 리뷰 사진" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>` : ''}</div><div class="reply-section"><div class="reply-section-head"><span class="reply-title">${icon(r.hasReply ? 'check-circle' : 'sparkles')}${r.hasReply ? '등록된 답글' : '답글 작성'}</span>${!r.hasReply ? `<button id="generate-button" class="ai-button ${generating ? 'busy' : ''}" ${generating || state.publishing ? 'disabled' : ''}>${icon('sparkles')}${generating ? '추천 작성 중' : 'GPT 추천받기'}</button>` : ''}</div>${r.hasReply ? `<div class="posted-reply">${r.reply ? esc(r.reply) : `이미 답글이 등록되어 있어요. 아래 ‘${label} 답글 확인’을 누르면 내용을 가져옵니다.`}</div><p class="posted-info">${label}에 등록된 답글입니다.${r.replyDate ? ` · ${esc(r.replyDate)}` : ''}</p>` : `<div class="editor-wrap"><textarea id="reply-editor" maxlength="${maxLength}" aria-label="판매자 답글" placeholder="고객에게 전할 답글을 작성해 주세요.&#10;GPT 추천을 받은 뒤 자유롭게 수정할 수 있어요." ${state.publishing ? 'disabled' : ''}>${esc(draft)}</textarea><div class="editor-meta"><span id="draft-status">${draft ? '초안 저장됨' : '작성한 내용은 초안으로 저장됩니다'}</span><span><span id="char-count">${draft.length}</span> / ${maxLength.toLocaleString('ko-KR')}</span></div></div>${suggestion ? `<div class="suggestion-preview"><span class="reply-title">${icon('sparkles')}새 추천 답글</span><p>${esc(suggestion)}</p><button class="button secondary" id="apply-suggestion">이 추천으로 바꾸기</button></div>` : ''}<div class="reply-helper">${icon('info')}${r.replyAllowed === false ? '이 리뷰는 서비스의 댓글 등록 가능 기간·상태를 확인해 주세요.' : '추천 문구를 확인하고 브랜드의 말투로 다듬어 주세요.'}</div>`}</div><div class="reply-actions"><button class="text-button" id="load-reply">${label} 답글 확인 ${icon('external')}</button>${!r.hasReply ? `<button class="button primary" id="prepare-publish" ${draft.trim().length < 5 || draft.length > maxLength || r.replyAllowed === false || !reviewConnected(r) || state.publishing || generating ? 'disabled' : ''}>${icon('send')}등록 내용 확인</button>` : `<span class="badge replied">${icon('check-circle')} 등록 완료</span>`}</div>`;
  if (!r.hasReply) renderToneControls(r.id, generating || state.publishing);
  $('#reply-editor')?.addEventListener('input', event => onEdit(r.id, event.target.value));
  $('#generate-button')?.addEventListener('click', () => generate(r.id));
  $('#load-reply')?.addEventListener('click', () => loadDetail(r.id));
  $('#prepare-publish')?.addEventListener('click', () => preparePublish(r.id));
  $('#apply-suggestion')?.addEventListener('click', () => { onEdit(r.id, state.suggestions.get(r.id)); state.suggestions.delete(r.id); renderDetail(); });
}
function onEdit(id, text) {
  state.drafts[id] = { text }; state.edits.set(id, (state.edits.get(id) || 0) + 1);
  if (state.selected === id) { $('#char-count').textContent = text.length; $('#draft-status').textContent = '저장 중…'; $('#prepare-publish').disabled = text.trim().length < 5 || text.length > replyLimit(current()) || current()?.replyAllowed === false || !reviewConnected(state.reviews.find(r => r.id === id)) || state.publishing || state.generating.has(id); }
  clearTimeout(state.saveTimers.get(id)); state.saveTimers.set(id, setTimeout(() => saveDraft(id).catch(() => {}), 450)); renderStats(); renderList();
}
async function saveDraft(id) {
  clearTimeout(state.saveTimers.get(id));
  if (state.reviews.find(r => r.id === id)?.hasReply) return;
  const text = state.drafts[id]?.text || '';
  const prev = state.saving.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => api(`/api/reviews/${id}/draft`, { text })); state.saving.set(id, next);
  try { await next; if (state.selected === id && $('#draft-status') && state.drafts[id]?.text === text) $('#draft-status').textContent = '초안 저장됨'; }
  catch (e) { if (state.reviews.find(r => r.id === id)?.hasReply) return; if (state.selected === id && $('#draft-status')) $('#draft-status').textContent = '초안 저장 실패'; toast(e.message, true); throw e; }
}
async function generate(id) {
  const choice = replyTones.get(id) || { value: 'default', custom: '' };
  const tone = choice.value === 'default' ? undefined : choice.value === 'custom' ? choice.custom.trim() : choice.value;
  if (tone !== undefined && (!tone || tone.length > 200)) { toast('원하는 말투를 1~200자로 입력해 주세요.', true); $('#reply-tone-custom')?.focus(); return; }
  if (!state.aiConfigured) { openSettings(); toast('OpenAI API 키를 먼저 연결해 주세요.'); return; }
  const editAtStart = state.edits.get(id) || 0, existing = state.drafts[id]?.text || '';
  state.generating.add(id); renderDetail();
  try {
    const { text } = await api(`/api/reviews/${id}/suggest`, { tone });
    if (state.reviews.find(r => r.id === id)?.hasReply) return;
    if (existing.trim() || (state.edits.get(id) || 0) !== editAtStart) { state.suggestions.set(id, text); toast('기존 초안 옆에 새 추천을 준비했습니다.'); }
    else { state.drafts[id] = { text }; await saveDraft(id); toast('추천 답글이 준비되었습니다. 내용을 확인하고 수정해 주세요.'); }
  } catch (e) { toast(e.message, true); }
  finally { state.generating.delete(id); if (state.selected === id) renderDetail(); renderStats(); renderList(); }
}
function applyReviewUpdate(review) {
  const local = state.reviews.find(r => r.id === review.id); if (!local) return;
  reviewRevision++;
  Object.assign(local, review);
  if (review.hasReply) {
    clearTimeout(state.saveTimers.get(review.id)); state.saveTimers.delete(review.id);
    delete state.drafts[review.id]; state.suggestions.delete(review.id);
    if (!state.publishing && state.intent?.id === review.id) { state.intent = null; $('#publish-dialog').close(); }
  }
}
async function refreshReviews() {
  if (state.publishing || state.refreshingReviews) return;
  state.refreshingReviews = true;
  try {
    const revision = reviewRevision;
    const result = await api('/api/reviews');
    if (state.publishing || revision !== reviewRevision) return;
    const detailKey = () => JSON.stringify(current());
    const selectedBefore = detailKey(), oldIds = new Set(state.reviews.map(r => r.id));
    const list = $('#review-list'), top = list.getBoundingClientRect().top;
    const anchor = [...list.querySelectorAll('[data-review]')].find(card => card.getBoundingClientRect().bottom > top);
    const anchorId = anchor?.dataset.review, anchorTop = anchor?.getBoundingClientRect().top;
    const previous = JSON.stringify([state.reviews, state.lastSync, state.sync, state.syncs, state.reviewPeriod]);
    state.reviews = result.reviews; state.lastSync = result.lastSync; state.sync = result.sync; state.syncs = result.syncs || {};
    if (result.reviewPeriod) state.reviewPeriod = result.reviewPeriod;
    if (result.autoSync) { state.autoSync = result.autoSync; renderAutoSync(); }
    // Preserve local edits while accepting confirmed replies from another tab.
    state.drafts = { ...result.drafts, ...state.drafts };
    for (const r of state.reviews) if (r.hasReply) applyReviewUpdate(r);
    if (!current()) state.selected = filtered()[0]?.id || null;
    if (previous !== JSON.stringify([state.reviews, state.lastSync, state.sync, state.syncs, state.reviewPeriod])) {
      renderStats(); renderList();
      const newAnchor = [...list.querySelectorAll('[data-review]')].find(card => card.dataset.review === anchorId);
      if (newAnchor && anchorTop !== undefined) list.scrollTop += newAnchor.getBoundingClientRect().top - anchorTop;
      const added = state.reviews.filter(r => !oldIds.has(r.id)).length;
      if (added) { $('#live-update-message').hidden = false; $('#live-update-message').textContent = `새로 가져온 리뷰 ${added}개를 목록에 반영했습니다.`; }
    }
    if (selectedBefore !== detailKey()) {
      const editor = $('#reply-editor'), editing = editor && document.activeElement === editor;
      const selection = editing ? [editor.selectionStart, editor.selectionEnd, editor.scrollTop] : null;
      renderDetail();
      if (selection && $('#reply-editor')) { $('#reply-editor').focus({ preventScroll: true }); $('#reply-editor').setSelectionRange(selection[0], selection[1]); $('#reply-editor').scrollTop = selection[2]; }
    }
  } finally { state.refreshingReviews = false; }
}
function renderAutoSync() {
  const config = state.autoSync; $('#auto-sync-panel').hidden = !config;
  if (!config) return;
  if (!state.savingAutoSync) { $('#auto-sync-enabled').checked = config.enabled; $('#auto-sync-interval').value = String(config.intervalMinutes); }
  $('#auto-sync-enabled').disabled = Boolean(state.savingAutoSync); $('#auto-sync-interval').disabled = Boolean(state.savingAutoSync);
  const time = value => value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '';
  const jobs = config.platforms || {}, running = Object.values(jobs).some(job => ['checking', 'syncing'].includes(job.phase));
  const errorCount = config.enabled ? Object.values(jobs).filter(job => job.error).length : 0;
  $('#auto-sync-alert').hidden = !errorCount;
  $('#auto-sync-alert').textContent = `${errorCount}개 확인 필요`;
  const next = Object.values(jobs).map(job => job.nextRunAt).filter(Boolean).sort()[0];
  $('#auto-sync-summary').textContent = state.savingAutoSync ? '설정 저장 중…' : !config.enabled ? running ? '진행 중인 조회를 마친 뒤 중지합니다' : '자동 가져오기 꺼짐' : running ? '스토어에서 새 리뷰를 확인하고 있어요' : next ? `다음 확인 ${time(next)}` : '자동 가져오기 켜짐';
  $('#auto-sync-platforms').innerHTML = platforms.map(platform => {
    const job = jobs[platform] || {}, error = config.enabled && job.error;
    const label = config.enabled && job.phase === 'checking' ? '연결 확인 중' : job.phase === 'syncing' ? '가져오는 중' : error ? job.phase === 'login_required' ? '로그인 확인 필요' : '조회 확인 필요' : job.lastSuccessAt ? `${time(job.lastSuccessAt)} 조회 완료` : '첫 조회 대기';
    return `<div class="auto-sync-item ${error ? 'has-error' : ''}"><strong>${platformLabel(platform)}</strong><span>${esc(label)}</span>${error ? `<small>${esc(job.error)}</small>` : ''}</div>`;
  }).join('');
}
async function saveAutoSync() {
  if (state.savingAutoSync) return;
  const data = { enabled: $('#auto-sync-enabled').checked, intervalMinutes: Number($('#auto-sync-interval').value) };
  state.savingAutoSync = true; renderAutoSync();
  try { state.autoSync = await api('/api/auto-sync/settings', data); toast(data.enabled ? `${data.intervalMinutes}분마다 새 리뷰를 자동으로 가져옵니다.` : '자동 가져오기를 껐습니다.'); }
  catch (error) { toast(error.message, true); }
  finally { state.savingAutoSync = false; renderAutoSync(); }
}
async function loadDetail(id) {
  const label = platformLabel(platformOf(state.reviews.find(r => r.id === id))); 
  const button = $('#load-reply'); if (button) { button.disabled = true; button.textContent = `${label}에서 확인 중…`; }
  try { const r = await api(`/api/reviews/${id}/detail`, {}); applyReviewUpdate(r); if (state.selected === id) renderDetail(); renderStats(); renderList(); toast(r.hasReply ? `${label}에 등록된 답글을 확인했습니다.` : '아직 등록된 답글이 없습니다.'); }
  catch (e) { toast(e.message, true); if (state.selected === id) renderDetail(); }
}
async function preparePublish(id) {
  if (state.publishing) return;
  try {
    const r = state.reviews.find(x => x.id === id); await saveDraft(id);
    const intent = await api(`/api/reviews/${id}/prepare`, { text: state.drafts[id]?.text || '', fingerprint: r.fingerprint });
    state.intent = { ...intent, id }; $('#confirm-product').textContent = r.product; $('#confirm-original').textContent = r.content; $('#confirm-text').textContent = intent.text;
    const label = platformLabel(platformOf(r)); $('#confirm-product').textContent = `${label} · ${r.storeName || r.store || ''} · ${r.product}`;
    $('#confirm-publish').innerHTML = `${icon('send')}${label}에 등록`; $('#publish-notice').textContent = `아래 버튼을 누르면 이 답글이 실제 ${label} 리뷰에 등록됩니다.`;
    $('#publish-dialog').showModal();
  } catch (e) { toast(e.message, true); }
}
async function publish() {
  if (!state.intent || state.publishing) return;
  const intent = state.intent; const label = platformLabel(platformOf(state.reviews.find(r => r.id === intent.id))); state.intent = null; state.publishing = true;
  $('#confirm-publish').disabled = true; $('#confirm-publish').textContent = `${label}에 등록 중…`;
  for (const button of $('#publish-dialog').querySelectorAll('[data-close]')) button.disabled = true;
  try {
    const result = await api(`/api/reviews/${intent.id}/publish`, { token: intent.token });
    applyReviewUpdate(result.review);
    toast(`${label}에 답글이 등록되었습니다. 저장된 내용까지 확인했어요.`);
  } catch (e) {
    $('#confirm-publish').textContent = '등록 결과 다시 확인 중…';
    const verified = await api(`/api/reviews/${intent.id}/detail`, {}).catch(() => null);
    if (verified?.hasReply) {
      applyReviewUpdate(verified);
      toast(e.code === 'REPLY_MISMATCH' ? e.message : `${label}에 등록된 답글을 다시 확인해 앱에 반영했습니다.`, e.code === 'REPLY_MISMATCH');
    } else toast(e.message, true);
  }
  finally { state.publishing = false; $('#publish-dialog').close(); $('#confirm-publish').disabled = false; $('#confirm-publish').innerHTML = `${icon('send')}${label}에 등록`; for (const b of $('#publish-dialog').querySelectorAll('[data-close]')) b.disabled = false; renderStats(); renderList(); renderDetail(); }
}
async function refreshStatus() {
  try { const status = await api('/api/status'); state.connected = status.connected; state.aiConfigured = status.aiConfigured;
    state.autoLogin = status.autoLogin || {}; state.aiKey = status.aiKey || {};
    state.platforms = status.platforms || { naver: { connected: status.connected }, coupang: { connected: false } };
    state.coupangAutoLogin = state.platforms.coupang?.autoLogin || {};
    state.ablyAutoLogin = state.platforms.ably?.autoLogin || {};
    state.deliveryAutoLogin = status.deliveryAutoLogin || {};
    renderConnections();
    $('#sidebar-connection').textContent = status.connected ? (state.autoLogin.enabled ? '연결됨 · 자동 로그인 켜짐' : '연결됨') : state.autoLogin.phase === 'reconnecting' ? '다시 로그인하는 중…' : '연결 확인이 필요해요'; $('#connection-dot').classList.toggle('connected', status.connected);
    $('#connection-message').textContent = status.networkError ? '네이버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요. 초안은 보관됩니다.' : authMessage();
    $('#auth-state').textContent = authMessage(); $('#auth-open').classList.toggle('connected', Boolean(state.autoLogin.enabled));
    if ($('#prepare-publish')) $('#prepare-publish').disabled = !reviewConnected(current()) || current()?.replyAllowed === false || (state.drafts[state.selected]?.text || '').length > replyLimit(current()) || (state.drafts[state.selected]?.text || '').trim().length < 5 || state.publishing || state.generating.has(state.selected);
    renderAIStatus();
    await refreshReviews();
  } catch { for (const id of ['sidebar-connection', 'coupang-sidebar-connection', 'ably-sidebar-connection', ...Object.keys(deliveryPlatforms).map(p => p + '-sidebar-connection')]) $(`#${id}`).textContent = '앱 서버 연결 끊김'; state.connected = false; if ($('#prepare-publish')) $('#prepare-publish').disabled = true; }
}
function renderConnections() {
  if ($('#delivery-settings-dialog').open) renderDeliverySettings();
  const connectedServices = ['naver', 'coupang', 'ably'].filter(platform => state.platforms[platform]?.connected).length
    + ['baemin', 'coupangeats'].filter(provider => Object.entries(deliveryPlatforms).some(([platform, config]) => config.provider === provider && state.platforms[platform]?.connected)).length;
  $('#connection-summary').textContent = `${connectedServices}/5 연결됨`;
  $('#connection-summary').classList.toggle('has-attention', connectedServices < 5);
  for (const [platform, config] of Object.entries(deliveryPlatforms)) {
    const status = state.platforms[platform] || {}, connected = Boolean(status.connected);
    const auth = state.deliveryAutoLogin[config.provider] || {};
    document.getElementById(platform + '-sidebar-connection').textContent = connected ? (auth.enabled ? '연결됨 · 자동 로그인 켜짐' : '연결됨 · 답글 가능') : auth.phase === 'reconnecting' ? '자동 로그인 중…' : auth.phase === 'needs_verification' ? '추가 인증 필요' : '로그인 확인 필요';
    document.getElementById(platform + '-connection-dot').classList.toggle('connected', connected);
  }
  const delivery = deliveryPlatforms[state.platform];
  $('#delivery-connection-banner').hidden = !delivery || Boolean(state.platforms[state.platform]?.connected);
  if (delivery) { const status = state.platforms[state.platform] || {}; $('#delivery-connection-message').textContent = status.connected ? (status.storeName || delivery.brand) + ' 리뷰를 가져오고 답글을 등록할 수 있습니다.' : status.message || delivery.providerLabel + ' 연결 창에서 로그인해 주세요.'; $('#delivery-connect-button').textContent = delivery.label + ' 연결 창 열기 ↗'; }

  const coupang = Boolean(state.platforms.coupang?.connected), auth = state.coupangAutoLogin || {};
  $('#connection-banner').hidden = state.connected || state.platform !== 'naver';
  $('#coupang-connection-banner').hidden = coupang || state.platform !== 'coupang';
  $('#coupang-sidebar-connection').textContent = coupang ? (auth.enabled ? '연결됨 · 자동 로그인 켜짐' : '연결됨 · 조회 전용') : auth.phase === 'reconnecting' ? '다시 로그인하는 중…' : '연결 확인 필요 · 조회 전용';
  $('#coupang-connection-dot').classList.toggle('connected', coupang);
  $('#coupang-open').textContent = '판매자센터 열기 ↗';
  $('#coupang-connection-message').textContent = coupangAuthMessage();
  $('#coupang-auth-state').textContent = coupangAuthMessage();
  $('#coupang-auth-open').classList.toggle('connected', Boolean(auth.enabled));
  const ably = Boolean(state.platforms.ably?.connected), ablyAuth = state.ablyAutoLogin || {};
  $('#ably-connection-banner').hidden = ably || state.platform !== 'ably';
  $('#ably-sidebar-connection').textContent = ably ? (ablyAuth.enabled ? '연결됨 · 자동 로그인 켜짐' : '연결됨 · 조회 전용') : ablyAuth.phase === 'reconnecting' ? '다시 로그인하는 중…' : '로그인 필요 · 조회 전용';
  $('#ably-connection-message').textContent = ablyAuthMessage();
  $('#ably-auth-state').textContent = ablyAuthMessage();
  $('#ably-auth-open').classList.toggle('connected', Boolean(ablyAuth.enabled));
  $('#ably-connection-dot').classList.toggle('connected', ably);
  $('#ably-open').textContent = '판매자센터 열기 ↗';
}
function coupangAuthMessage() {
  const auth = state.coupangAutoLogin || {};
  if (auth.phase === 'reconnecting') return '쿠팡에 다시 로그인하는 중입니다. 저장된 리뷰는 그대로 보관됩니다.';
  if (auth.blocked === 'verification' || auth.phase === 'needs_verification') return '쿠팡 추가 인증이 필요합니다. 연결 창에서 직접 완료해 주세요. 완료되면 자동으로 연결 상태를 확인합니다.';
  if (auth.blocked === 'invalid_credentials') return '쿠팡 아이디 또는 비밀번호를 확인해 주세요. 쿠팡 연결 설정에서 정보를 수정해 저장하면 다시 시도합니다.';
  if (auth.blocked === 'storage_error') return '저장된 쿠팡 로그인 정보를 읽지 못했습니다. 이 Windows 계정에서 다시 저장해 주세요.';
  if (auth.blocked) return '쿠팡 자동 로그인을 완료하지 못했습니다. 연결 창을 확인해 주세요. 다시 시도하려면 설정을 저장해 주세요.';
  if (auth.phase === 'offline' || state.platforms.coupang?.networkError) return '쿠팡 연결을 확인하지 못했습니다. 인터넷 연결을 확인해 주세요. 저장된 리뷰는 보관됩니다.';
  if (auth.phase === 'cooldown') return '쿠팡 로그인이 다시 만료되어 잠시 후 재연결합니다. 연결 창에서 직접 로그인할 수도 있습니다.';
  if (state.platforms.coupang?.connected) return auth.enabled ? '쿠팡에 연결되어 있습니다. 로그인이 만료되면 자동으로 재연결합니다.' : '쿠팡에 연결되어 있습니다. 아래에서 자동 로그인을 설정할 수 있습니다.';
  return auth.enabled ? '쿠팡 연결을 확인하고 있습니다. 추가 인증이 필요하면 알려드릴게요.' : '쿠팡 연결 창에서 로그인하거나, 쿠팡 연결 설정에서 자동 로그인을 켜 주세요.';
}
async function openCoupangAuth() {
  await refreshStatus(); const auth = state.coupangAutoLogin || {};
  $('#coupang-auth-enabled').checked = auth.configured ? Boolean(auth.enabled) : true;
  for (const field of ['username', 'password']) { const input = $(`#coupang-auth-${field}`); input.value = ''; input.placeholder = auth.configured ? (field === 'username' ? '저장된 아이디 사용 · 계정 변경 시 입력' : '변경한 새 비밀번호 입력 · 비우면 유지') : '처음 연결할 때 입력'; }
  $('#coupang-auth-forget').disabled = !auth.configured; $('#coupang-auth-message').textContent = ''; $('#coupang-auth-dialog').showModal();
}
$('#coupang-auth-open').addEventListener('click', openCoupangAuth);
$('#coupang-auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    state.coupangAutoLogin = await api('/api/auth/coupang/settings', { enabled: $('#coupang-auth-enabled').checked, method: 'coupang', username: $('#coupang-auth-username').value, password: $('#coupang-auth-password').value });
    $('#coupang-auth-username').value = ''; $('#coupang-auth-password').value = ''; $('#coupang-auth-dialog').close(); await refreshStatus();
    toast(state.coupangAutoLogin.enabled ? '쿠팡 자동 로그인을 설정했습니다. 추가 인증이 필요하면 알려드릴게요.' : '쿠팡 자동 로그인을 껐습니다.');
  } catch (e) { $('#coupang-auth-message').textContent = e.message; } finally { button.disabled = false; }
});
$('#coupang-auth-forget').addEventListener('click', async () => {
  try { state.coupangAutoLogin = await api('/api/auth/coupang/forget', {}); $('#coupang-auth-username').value = ''; $('#coupang-auth-password').value = ''; $('#coupang-auth-enabled').checked = false; $('#coupang-auth-forget').disabled = true; $('#coupang-auth-message').textContent = '저장된 쿠팡 로그인 정보를 삭제했습니다. 현재 쿠팡 로그인은 유지됩니다.'; await refreshStatus(); }
  catch (e) { $('#coupang-auth-message').textContent = e.message; }
});
$('#coupang-auth-dialog').addEventListener('close', () => { $('#coupang-auth-username').value = ''; $('#coupang-auth-password').value = ''; });
$('#coupang-auth-browser').addEventListener('click', () => openBrowser('coupang'));
function ablyAuthMessage() {
  const auth = state.ablyAutoLogin || {};
  if (auth.phase === 'reconnecting') return '에이블리에 다시 로그인하는 중입니다. 저장된 리뷰는 그대로 보관됩니다.';
  if (auth.blocked === 'verification' || auth.phase === 'needs_verification') return '에이블리 추가 인증이 필요합니다. 연결 창에서 직접 완료해 주세요. 완료되면 자동으로 연결 상태를 확인합니다.';
  if (auth.blocked === 'invalid_credentials') return '에이블리 아이디 또는 비밀번호를 확인해 주세요. 에이블리 연결 설정에서 정보를 수정해 저장하면 다시 시도합니다.';
  if (auth.blocked === 'storage_error') return '저장된 에이블리 로그인 정보를 읽지 못했습니다. 이 Windows 계정에서 다시 저장해 주세요.';
  if (auth.blocked) return '에이블리 자동 로그인을 완료하지 못했습니다. 연결 창을 확인해 주세요. 다시 시도하려면 설정을 저장해 주세요.';
  if (auth.phase === 'offline' || state.platforms.ably?.networkError) return '에이블리 연결을 확인하지 못했습니다. 인터넷 연결을 확인해 주세요. 저장된 리뷰는 보관됩니다.';
  if (auth.phase === 'cooldown') return '에이블리 로그인이 다시 만료되어 잠시 후 재연결합니다. 연결 창에서 직접 로그인할 수도 있습니다.';
  if (state.platforms.ably?.connected) return auth.enabled ? '에이블리에 연결되어 있습니다. 로그인이 만료되면 자동으로 재연결합니다.' : '에이블리에 연결되어 있습니다. 아래에서 자동 로그인을 설정할 수 있습니다.';
  return auth.enabled ? '에이블리 연결을 확인하고 있습니다. 추가 인증이 필요하면 알려드릴게요.' : '에이블리 연결 창에서 로그인하거나, 에이블리 연결 설정에서 자동 로그인을 켜 주세요.';
}
async function openAblyAuth() {
  await refreshStatus(); const auth = state.ablyAutoLogin || {};
  $('#ably-auth-enabled').checked = auth.configured ? Boolean(auth.enabled) : true;
  for (const field of ['username', 'password']) { const input = $(`#ably-auth-${field}`); input.value = ''; input.placeholder = auth.configured ? (field === 'username' ? '저장된 아이디 사용 · 계정 변경 시 입력' : '변경한 새 비밀번호 입력 · 비우면 유지') : '처음 연결할 때 입력'; }
  $('#ably-auth-forget').disabled = !auth.configured; $('#ably-auth-message').textContent = ''; $('#ably-auth-dialog').showModal();
}
$('#ably-auth-open').addEventListener('click', openAblyAuth);
$('#ably-auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    state.ablyAutoLogin = await api('/api/auth/ably/settings', { enabled: $('#ably-auth-enabled').checked, method: 'ably', username: $('#ably-auth-username').value, password: $('#ably-auth-password').value });
    $('#ably-auth-username').value = ''; $('#ably-auth-password').value = ''; $('#ably-auth-dialog').close(); await refreshStatus();
    toast(state.ablyAutoLogin.enabled ? '에이블리 자동 로그인을 설정했습니다. 추가 인증이 필요하면 알려드릴게요.' : '에이블리 자동 로그인을 껐습니다.');
  } catch (e) { $('#ably-auth-message').textContent = e.message; } finally { button.disabled = false; }
});
$('#ably-auth-forget').addEventListener('click', async () => {
  try { state.ablyAutoLogin = await api('/api/auth/ably/forget', {}); $('#ably-auth-username').value = ''; $('#ably-auth-password').value = ''; $('#ably-auth-enabled').checked = false; $('#ably-auth-forget').disabled = true; $('#ably-auth-message').textContent = '저장된 에이블리 로그인 정보를 삭제했습니다. 현재 에이블리 로그인은 유지됩니다.'; await refreshStatus(); }
  catch (e) { $('#ably-auth-message').textContent = e.message; }
});
$('#ably-auth-dialog').addEventListener('close', () => { $('#ably-auth-username').value = ''; $('#ably-auth-password').value = ''; });
$('#ably-auth-browser').addEventListener('click', () => openBrowser('ably'));
function authMessage() {
  const a = state.autoLogin;
  if (a.phase === 'reconnecting') return '네이버에 다시 로그인하는 중입니다. 작성한 초안은 그대로 보관됩니다.';
  if (a.blocked === 'verification' || a.phase === 'needs_verification') return '추가 인증이 필요합니다. 연결 창에서 인증을 완료해 주세요. 완료되면 자동으로 연결 상태를 확인합니다.';
  if (a.blocked === 'invalid_credentials') return '아이디 또는 비밀번호를 확인해 주세요. 네이버 연결 설정에서 정보를 수정해 저장하면 다시 시도합니다.';
  if (a.blocked === 'storage_error') return '저장된 로그인 정보를 읽지 못했습니다. 네이버 연결 설정에서 다시 입력해 주세요.';
  if (a.blocked) return '자동 로그인을 완료하지 못했습니다. 연결 창을 확인해 주세요. 재시도하려면 네이버 연결 설정을 다시 저장하세요.';
  if (a.phase === 'offline') return '네이버에 연결하지 못했습니다. 인터넷 연결이 복구되면 다시 확인합니다.';
  if (a.phase === 'cooldown') return '로그인이 다시 만료되어 잠시 기다린 뒤 재연결합니다. 연결 창에서 직접 로그인할 수도 있습니다.';
  if (state.connected) return a.enabled ? '연결되어 있습니다. 로그인이 만료되면 자동으로 재연결합니다.' : '현재 연결되어 있습니다. 아래에서 자동 로그인을 설정할 수 있습니다.';
  return a.enabled ? '네이버 연결을 확인하고 있습니다. 추가 인증이 필요하면 알려드릴게요.' : '네이버 연결 창에서 로그인해 주세요. 연결 설정에서 자동 로그인을 켤 수 있습니다.';
}
async function openAuth() {
  await refreshStatus(); const a = state.autoLogin;
  $('#auth-enabled').checked = a.configured ? Boolean(a.enabled) : true; $('#auth-method').value = a.method || 'naver';
  $('#auth-username').value = ''; $('#auth-password').value = '';
  $('#auth-username').placeholder = a.configured ? '저장된 아이디 사용 · 계정 변경 시 입력' : '처음 연결할 때 입력';
  $('#auth-password').placeholder = a.configured ? '변경한 새 비밀번호 입력 · 비우면 유지' : '처음 연결할 때 입력';
  $('#auth-forget').disabled = !a.configured; $('#auth-message').textContent = ''; $('#auth-dialog').showModal();
}
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    state.autoLogin = await api('/api/auth/settings', { enabled: $('#auth-enabled').checked, method: $('#auth-method').value, username: $('#auth-username').value, password: $('#auth-password').value });
    $('#auth-username').value = ''; $('#auth-password').value = ''; $('#auth-dialog').close(); await refreshStatus();
    toast(state.autoLogin.enabled ? '자동 로그인을 설정했습니다. 추가 인증이 필요하면 알려드릴게요.' : '자동 로그인을 껐습니다.');
  } catch (e) { $('#auth-message').textContent = e.message; } finally { button.disabled = false; }
});
$('#auth-forget').addEventListener('click', async () => {
  try { state.autoLogin = await api('/api/auth/forget', {}); $('#auth-username').value = ''; $('#auth-password').value = ''; $('#auth-enabled').checked = false; $('#auth-forget').disabled = true; $('#auth-message').textContent = '저장된 로그인 정보를 삭제했습니다. 현재 네이버 로그인은 유지됩니다.'; await refreshStatus(); }
  catch (e) { $('#auth-message').textContent = e.message; }
});
$('#auth-dialog').addEventListener('close', () => { $('#auth-username').value = ''; $('#auth-password').value = ''; });
$('#auth-open').addEventListener('click', openAuth);
$('#auth-browser').addEventListener('click', openBrowser);
function renderAIStatus() {
  $('#ai-status').textContent = state.aiConfigured ? 'GPT 연결됨' : 'GPT 연결하기'; $('#ai-chip').classList.toggle('connected', state.aiConfigured);
  const key = state.aiKey || {};
  $('#settings-key-storage').textContent = key.storageError ? '저장된 API 키를 읽지 못했습니다. 이 Windows 계정에서 키를 다시 저장해 주세요.' : key.saved ? '이 PC에 암호화해 저장했습니다. 다음 실행부터 자동으로 연결됩니다.' : state.aiConfigured ? '키가 연결되어 있습니다. 설정을 저장하면 암호화해 보관합니다.' : '키를 한 번 저장하면 다음 실행부터 자동으로 연결됩니다.';
  $('#settings-key-forget').disabled = state.savingSettings || !(state.aiConfigured || key.saved || key.storageError);
  $('#settings-ai-state').textContent = state.aiConfigured ? key.saved ? '암호화 저장됨' : '연결됨' : key.storageError ? '다시 저장 필요' : '연결 전';
  $('#settings-ai-state').className = `badge ${state.aiConfigured ? 'replied' : 'pending'}`;
}
async function openBrowser(platform = 'naver') {
  if (typeof platform !== 'string') platform = 'naver';
  const label = platformLabel(platform);
  try { toast(`${label} 연결 창을 여는 중입니다.`); await api('/api/browser/open', { platform }); await refreshStatus(); const connected = platform === 'naver' ? state.connected : state.platforms[platform]?.connected; toast(connected ? `${label} 연결이 완료되었습니다. 리뷰를 가져와 주세요.` : `새로 열린 ${label} 창에서 로그인과 추가 인증을 완료해 주세요.`); } catch (e) { toast(e.message, true); }
}
async function sync() {
  if (state.syncing || state.publishing) return;
  const period = $('#period').value;
  state.syncing = true; state.reviewPeriod = period; state.syncRequest = { period, baselines: Object.fromEntries(platforms.map(p => [p, syncInfo(p)?.lastSync])) }; state.syncErrors = {}; reviewRevision++; renderStats();
  $('#sync-button').disabled = true; $('#sync-button').classList.add('busy'); $('#sync-button').lastElementChild.textContent = '리뷰 가져오는 중';
  try {
    await Promise.all([...state.saveTimers.keys()].map(id => state.reviews.find(r => r.id === id)?.hasReply ? Promise.resolve() : saveDraft(id)));
    const result = await api('/api/sync', { period, platform: 'all' });
    Object.assign(state, result, { drafts: { ...result.drafts, ...state.drafts } }); reviewRevision++;
    for (const warning of result.warnings || []) state.syncErrors[warning.platform] = { message: warning.message, lastSync: syncInfo(warning.platform)?.lastSync };
    for (const review of state.reviews) if (review.hasReply) applyReviewUpdate(review);
    const rows = filtered(); state.selected = rows.some(r => r.id === state.selected) ? state.selected : rows[0]?.id || null;
    renderStats(); renderList(); renderDetail(); await refreshStatus();
    toast(result.warnings?.length ? `일부 스토어 조회 실패: ${result.warnings.map(w => platformLabel(w.platform)).join(', ')}. 나머지 숫자는 선택한 기간으로 갱신했습니다.` : `전체 스토어의 ${periodLabels[period]} 리뷰 수를 갱신했습니다.`, Boolean(result.warnings?.length));
  } catch (e) { for (const platform of platforms) state.syncErrors[platform] = { message: e.message, lastSync: syncInfo(platform)?.lastSync }; toast(e.message, true); await refreshStatus(); }
  finally { state.syncing = false; state.syncRequest = null; renderStats(); $('#sync-button').disabled = false; $('#sync-button').classList.remove('busy'); $('#sync-button').lastElementChild.textContent = '전체 스토어 새로고침'; }
}
function openSettings() {
  state.settingsPlatform = deliveryPlatforms[state.platform] ? state.platform : undefined;
  const preferences = storePreferences(state.platform); $('#setting-brand').disabled = Boolean(state.settingsPlatform);
  $('#settings-scope').textContent = state.settingsPlatform ? platformLabel(state.settingsPlatform) + '의 말투와 운영 지침을 별도로 저장합니다.' : '네이버 브랜드 설정입니다. API 키와 모델은 모든 매장에서 함께 사용합니다.';
  $('#setting-brand').value = preferences.brand || '티웨스트'; $('#setting-tone').value = preferences.tone || '따뜻하고 정중하게'; $('#setting-guidance').value = preferences.guidance || ''; $('#setting-model').value = state.settings.model || 'gpt-5-mini';
  $('#setting-key').value = ''; $('#setting-key').placeholder = state.aiConfigured ? '연결됨 · 변경하려면 새 키 입력' : 'sk-…'; renderAIStatus(); $('#settings-message').textContent = ''; $('#settings-dialog').showModal();
}
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.savingSettings) return; state.savingSettings = true; const button = event.submitter; button.disabled = true; renderAIStatus();
  try {
    const result = await api('/api/settings', { platform: state.settingsPlatform, brand: $('#setting-brand').value, tone: $('#setting-tone').value, guidance: $('#setting-guidance').value, model: $('#setting-model').value, apiKey: $('#setting-key').value });
    $('#setting-key').value = ''; state.settings = result.settings; state.aiConfigured = result.aiConfigured; state.aiKey = result.aiKey || {}; $('#brand-name').textContent = state.settings.brand; renderAIStatus(); renderDetail(); $('#settings-dialog').close(); toast(state.aiKey.saved ? '설정을 저장했습니다. GPT 키는 다음 실행에도 자동으로 연결됩니다.' : '설정을 저장했습니다.');
  } catch (e) { $('#settings-message').textContent = e.message; } finally { state.savingSettings = false; button.disabled = false; renderAIStatus(); }
});
$('#settings-key-forget').addEventListener('click', async () => {
  if (state.savingSettings) return;
  state.savingSettings = true; renderAIStatus(); const saveButton = $('#settings-form button[type="submit"]'); saveButton.disabled = true;
  try {
    const result = await api('/api/settings', { disconnectAI: true });
    state.aiConfigured = result.aiConfigured; state.aiKey = result.aiKey || {}; $('#setting-key').value = ''; $('#setting-key').placeholder = 'sk-…';
    $('#settings-message').textContent = '이 앱에 저장된 API 키를 삭제하고 GPT 연결을 해제했습니다.';
  } catch (e) { $('#settings-message').textContent = e.message; }
  finally { state.savingSettings = false; saveButton.disabled = false; renderAIStatus(); }
});
$('#settings-dialog').addEventListener('close', () => { $('#setting-key').value = ''; });

let transferBusy=false, transferDownloadURL=null;
const transferNames={naver:'네이버',coupang:'쿠팡윙',ably:'에이블리',baemin:'배달의민족',coupangeats:'쿠팡이츠'};
const transferSummary=result=>[...result.providers.map(p=>transferNames[p]),...(result.includesGPT?['GPT 키']:[])].join(' · ');
function transferWorking(value) {
  transferBusy=value;
  for(const el of $('#transfer-dialog').querySelectorAll('button,input'))el.disabled=value;
}
function clearTransferPasswords() {for(const el of $('#transfer-dialog').querySelectorAll('input[type="password"]'))el.value='';}
$('#transfer-open').addEventListener('click',()=>{
  if(state.publishing)return;
  clearTransferPasswords();$('#transfer-file').value='';$('#transfer-confirm-replace').checked=false;
  $('#transfer-message').textContent='현재 PC의 로그인 정보는 파일을 만들어도 그대로 유지됩니다.';
  $('#transfer-dialog').showModal();
});
$('#transfer-export-form').addEventListener('submit',async event=>{
  event.preventDefault();if(transferBusy)return;
  let password=$('#transfer-export-password').value;
  if(password!==$('#transfer-export-confirm').value){clearTransferPasswords();$('#transfer-message').textContent='이전용 암호가 서로 다릅니다. 다시 입력해 주세요.';return;}
  transferWorking(true);clearTransferPasswords();$('#transfer-download').hidden=true;
  $('#transfer-message').textContent='저장된 로그인 정보와 GPT 키를 암호화하고 있습니다.';
  try{
    const result=await api('/api/credentials/export',{password});
    if(transferDownloadURL)URL.revokeObjectURL(transferDownloadURL);
    transferDownloadURL=URL.createObjectURL(new Blob([JSON.stringify(result.backup)],{type:'application/json'}));
    const link=$('#transfer-download');link.href=transferDownloadURL;link.download=`review-desk-login-${new Date().toISOString().slice(0,10)}.json`;link.hidden=false;link.click();
    $('#transfer-message').textContent=`${transferSummary(result)} 이전 파일을 만들었습니다. 다운로드한 파일과 정한 암호로 새 PC에서 복원하세요.`;
  }catch(e){$('#transfer-message').textContent=e.message;}
  finally{password='';transferWorking(false);}
});
$('#transfer-import-form').addEventListener('submit',async event=>{
  event.preventDefault();if(transferBusy)return;
  const file=$('#transfer-file').files[0];
  if(!file || file.size>24576){$('#transfer-message').textContent='리뷰 앱에서 만든 이전 파일을 선택해 주세요. 파일은 24KB 이하여야 합니다.';return;}
  if(!$('#transfer-confirm-replace').checked)return;
  let password=$('#transfer-import-password').value;clearTransferPasswords();transferWorking(true);
  $('#transfer-message').textContent='파일을 확인하고 이 PC에 저장하고 있습니다. 진행 중인 스토어 조회가 있으면 완료 후 처리합니다.';
  try{
    let backup;try{backup=JSON.parse(await file.text());}catch{throw new Error('이전 파일을 읽을 수 없습니다. 리뷰 앱에서 만든 파일을 선택해 주세요.');}
    const result=await api('/api/credentials/import',{backup,password,confirmed:true});
    state.aiConfigured=result.aiConfigured;state.aiKey=result.aiKey;renderAIStatus();
    $('#transfer-file').value='';$('#transfer-confirm-replace').checked=false;
    $('#transfer-message').textContent=`${transferSummary(result)} 복원이 완료됐습니다. 자동 로그인을 켜 둔 스토어에 연결합니다. 추가 인증이 나오면 연결 창에서 완료하세요.`;
    void refreshStatus();
  }catch(e){$('#transfer-message').textContent=e.message;}
  finally{password='';transferWorking(false);}
});
$('#transfer-dialog').addEventListener('cancel',event=>{if(transferBusy)event.preventDefault();});
$('#transfer-dialog').addEventListener('close',()=>{
  clearTransferPasswords();$('#transfer-file').value='';$('#transfer-confirm-replace').checked=false;
  if(transferDownloadURL){URL.revokeObjectURL(transferDownloadURL);transferDownloadURL=null;}
  $('#transfer-download').hidden=true;$('#transfer-download').removeAttribute('href');
});
document.addEventListener('click', event => {
  const platform = event.target.closest('[data-platform]'); if (platform) { selectPlatform(platform.dataset.platform); return; }
  const filter = event.target.closest('[data-filter]'); if (filter) { state.filter = filter.dataset.filter; renderList(); return; }
  const review = event.target.closest('[data-review]'); if (review) { state.selected = review.dataset.review; renderList(); renderDetail(); if (innerWidth < 901) $('#detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const close = event.target.closest('[data-close]'); if (close && !state.publishing) $(`#${close.dataset.close}`).close();
});
let updateBusy = false, updatePolling, updateState = {};
function renderUpdate(info = updateState) {
  updateState = info;
  $('#app-current-version').textContent = info.currentVersion || state.app?.version || '확인 중';
  $('#app-update-status').textContent = info.message || '업데이트를 확인해 주세요.';
  $('#app-update-progress').hidden = info.phase !== 'downloading';
  $('#app-update-progress').value = info.progress || 0;
  $('#app-update-check').disabled = updateBusy;
  $('#app-update-install').disabled = updateBusy || !info.available || info.phase === 'installing';
  $('[data-close="app-update-dialog"]').disabled = updateBusy;
}
$('#app-update-open').addEventListener('click', async () => {
  if (state.publishing) return;
  $('#app-update-dialog').showModal(); renderUpdate();
  try { renderUpdate(await api('/api/app/update')); } catch (error) { $('#app-update-status').textContent = error.message; }
});
$('#app-update-check').addEventListener('click', async () => {
  if (updateBusy) return;
  updateBusy = true; renderUpdate({ ...updateState, message: '새 버전을 확인하고 있습니다.' });
  try { updateState = await api('/api/app/update/check', {}); }
  catch (error) { updateState = { ...updateState, message: error.message, available: false }; }
  finally { updateBusy = false; renderUpdate(); }
});
$('#app-update-install').addEventListener('click', async () => {
  if (updateBusy) return;
  if (state.publishing || state.syncing || state.generating.size) { $('#app-update-status').textContent = '리뷰 가져오기·답글 작업이 끝난 뒤 설치해 주세요.'; return; }
  updateBusy = true; renderUpdate({ ...updateState, message: '작성한 초안을 저장하고 있습니다.' });
  try {
    await Promise.all([...state.saveTimers.keys()].map(id => saveDraft(id)));
    await Promise.all([...state.saving.values()]);
    updatePolling = setInterval(() => { api('/api/app/update').then(info => { if (updateBusy) renderUpdate(info); }).catch(() => {}); }, 1000);
    updateState = await api('/api/app/update/install', { confirmed: true });
  } catch (error) { updateState = { ...updateState, message: error.message }; }
  finally { clearInterval(updatePolling); updateBusy = false; renderUpdate(); }
});
$('#app-update-dialog').addEventListener('cancel', event => { if (updateBusy) event.preventDefault(); });
$('#publish-dialog').addEventListener('cancel', event => { if (state.publishing) event.preventDefault(); });
$('#publish-dialog').addEventListener('close', () => { if (!state.publishing) state.intent = null; });
$('#search').addEventListener('input', event => { state.query = event.target.value; renderList(); });
$('#rating-filter').addEventListener('change', event => { state.rating = event.target.value; renderList(); });
$('#sync-button').addEventListener('click', sync); $('#connect-button').addEventListener('click', openBrowser);
$('#period').addEventListener('change', sync);
$('#auto-sync-enabled').addEventListener('change', saveAutoSync); $('#auto-sync-interval').addEventListener('change', saveAutoSync);
for (const id of ['coupang-open', 'coupang-connect-button']) $(`#${id}`).addEventListener('click', () => openBrowser('coupang'));
for (const id of ['ably-open', 'ably-connect-button']) $(`#${id}`).addEventListener('click', () => openBrowser('ably'));
$('#settings-open').addEventListener('click', openSettings); $('#ai-chip').addEventListener('click', openSettings); $('#confirm-publish').addEventListener('click', publish);
try {
  const session = await api('/api/session'); Object.assign(state, session); $('#brand-name').textContent = state.settings.brand; renderAIStatus();
  const data = await api('/api/reviews'); Object.assign(state, data); const rows = filtered(); state.selected = rows.find(r => !r.hasReply)?.id || rows[0]?.id || null;
  const period = state.syncs.naver?.period || state.sync?.period; if (period) $('#period').value = period;
  renderStats(); renderList(); renderDetail(); renderAutoSync(); await refreshStatus();
} catch (e) { toast('앱 서버에 연결하지 못했습니다. 실행 상태를 확인해 주세요.', true); }
setInterval(refreshStatus, 20000);
setInterval(() => { void refreshReviews().catch(() => { $('#auto-sync-summary').textContent = '앱 서버 연결을 확인해 주세요'; }); }, 5000);
window.addEventListener('focus', () => { void refreshStatus(); });
