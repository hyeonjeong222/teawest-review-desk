const statuses = { pending: '답변 대기', answered: '답변 완료', closed: '종료' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uncertain = r => ['attempting', 'uncertain'].includes(r?.attempt?.state);
const completionUncertain = r => ['attempting', 'uncertain'].includes(r?.completionAttempt?.state);
const tones = ['따뜻하고 정중하게', '친근하고 밝게', '간결하고 담백하게', '공감하며 차분하게', '격식 있고 정중하게'];
const safeInquiryImage = value => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'd3ha2047wt6x28.cloudfront.net' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
const date = value => { const d = new Date(/^\d{13}$/.test(String(value)) ? Number(value) : value); return Number.isNaN(d.getTime()) ? value || '' : new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(d); };

export function createInquiryInbox({ api, toast, onSent, aiConfigured = () => false, openAISettings, platform = 'naver' }) {
  const isCoupang = platform === 'coupang', isAbly = platform === 'ably', prefix = platform === 'naver' ? '' : platform + '-', platformName = isAbly ? '에이블리' : isCoupang ? '쿠팡' : '네이버';
  const labels = isAbly ? { goods: '상품 문의', order_before_delivery: '배송 전 변경 / 취소문의', order_after_delivery: '교환 / 반품 문의', order_etc: '배송 / 기타 / 결제 문의', etc: '기타 문의', place: '플레이스 문의', affiliate_sponsorship: '협찬 문의' } : isCoupang ? { center: '고객센터 문의', customer: '고객문의' } : { talktalk: '톡톡 문의', customer: '주문 고객 문의', product: '상품 Q&A', center: '고객센터' };
  const root = document.querySelector('#' + prefix + 'inquiry-inbox');
  const scopeIds = () => { if (prefix) { root.querySelectorAll('[id^="inbox-"]').forEach(el => { el.id = prefix + el.id; }); root.querySelectorAll('[for^="inbox-"]').forEach(el => el.setAttribute('for', prefix + el.getAttribute('for'))); } };
  const state = { category: '', period: '3m', records: [], selected: null, detail: null, store: '', checkedAt: '', loading: false, detailLoading: false, busy: false, generation: 0, detailGeneration: 0, edits: new Map(), timers: new Map(), saves: new Map(), dirty: new Set() };
  const generating = new Map(), suggestions = new Map(), editVersions = new Map();
  let refreshing = false, refreshRevision = 0, refreshError = '';
  let tone = 'default', customTone = '';
  root.innerHTML = `<div class="inbox-toolbar"><div><h2 id="inbox-title">문의함</h2><p id="inbox-meta">문의 종류를 선택해 주세요.</p></div><div class="inbox-controls"><label><span class="sr-only">문의 조회 기간</span><select id="inbox-period"><option value="1m">최근 1개월</option><option value="3m" selected>최근 3개월</option></select></label><button id="inbox-refresh" class="button secondary">목록 새로고침</button></div></div>
    <p id="inbox-error" class="inbox-notice has-error" role="alert" hidden></p>
    <div class="inbox-columns"><section class="inbox-list-panel" aria-label="문의 목록"><div class="inbox-filters"><input id="inbox-search" type="search" placeholder="문의 내용, 상품, 고객 검색" aria-label="문의 검색"><select id="inbox-status" aria-label="문의 답변 상태"><option value="all">모든 상태</option><option value="pending">답변 대기</option><option value="answered">답변 완료</option><option value="draft">작성 중</option><option value="closed">종료</option></select></div><div id="inbox-list" aria-live="polite"></div></section><section id="inbox-detail" aria-label="문의 상세 및 답변"></section></div>
    <dialog id="inbox-confirm" class="inbox-confirm"><div class="dialog-header"><div><div class="eyebrow">NAVER INQUIRY</div><h2>이 답변을 등록할까요?</h2></div><button id="inbox-confirm-x" class="icon-button" aria-label="답변 확인 닫기">×</button></div><div id="inbox-confirm-body" class="dialog-body"></div><div class="dialog-footer"><button id="inbox-confirm-cancel" class="button secondary">돌아가서 수정</button><button id="inbox-confirm-send" class="button primary">답변 등록</button></div></dialog>`;
  scopeIds();
  const $ = selector => root.querySelector(selector.replaceAll('#inbox-', '#' + prefix + 'inbox-')), endpoint = (id, action) => `/api/inquiries/${platform}/${id}/${action}`;
  if (isCoupang) { state.period = '1m'; $('#inbox-period').value = '1m'; $('#inbox-period option[value="1m"]').textContent = '최근 30일'; $('#inbox-confirm .eyebrow').textContent = 'COUPANG INQUIRY'; }
  if (isAbly) { state.period = 'pending'; $('#inbox-period').insertAdjacentHTML('afterbegin', '<option value="pending">미완료 · 기간 제한 없음</option>'); $('#inbox-period').value = 'pending'; $('#inbox-confirm .eyebrow').textContent = 'ABLY INQUIRY'; $('#inbox-status option[value="pending"]').textContent = '진행 중 · 보류'; $('#inbox-status option[value="answered"]').textContent = '처리 완료'; }
  const dialog = $('#inbox-confirm'); let intent = null, publishing = false;
  function error(message = '') { $('#inbox-error').textContent = message; $('#inbox-error').hidden = !message; }
  function draft(r) { return r.replyMode === 'confirm' ? r.confirmationText : state.edits.has(r.id) ? state.edits.get(r.id) : r.draft || ''; }
  function renderList() {
    $('#inbox-title').textContent = labels[state.category] || '문의함';
    $('#inbox-meta').textContent = state.loading ? `${platformName} 문의를 가져오는 중…` : `${state.store || platformName} · ${state.records.length}건${state.checkedAt ? ' · ' + date(state.checkedAt) + ' 조회' : ''}`;
    $('#inbox-refresh').disabled = state.loading || state.busy;
    const query = $('#inbox-search').value.trim().toLowerCase(), status = $('#inbox-status').value;
    const records = state.records.filter(r => (status === 'all' || (status === 'draft' ? r.replyMode !== 'confirm' && draft(r).trim() : r.status === status)) && [r.title, r.content, r.product, r.author, r.orderNo].join(' ').toLowerCase().includes(query));
    $('#inbox-list').innerHTML = records.length ? records.map(r => `<button class="inbox-item${state.selected === r.id ? ' selected' : ''}" data-inbox-id="${esc(r.id)}" aria-pressed="${state.selected === r.id}"><span class="inbox-item-top"><strong>${esc(r.author || '고객')}</strong><time>${esc(date(r.date))}</time></span><span class="inbox-item-title">${esc((isAbly ? r.content || r.title : r.title || r.content) || '문의 내용 확인')}</span>${r.product ? `<span class="inbox-item-product">${esc(r.product)}</span>` : ''}<span class="inbox-state ${r.status}">${uncertain(r) ? '등록 확인 필요' : r.replyMode !== 'confirm' && draft(r).trim() ? '작성 중' : esc(r.statusLabel || statuses[r.status]) || '확인 필요'}</span></button>`).join('') : `<div class="empty"><h3>${state.loading ? '문의를 불러오고 있어요' : '표시할 문의가 없습니다'}</h3><p>${state.loading ? '잠시만 기다려 주세요.' : '조회 기간이나 검색 조건을 바꿔 보세요.'}</p></div>`;
  }
  function renderDetail() {
    const r = state.detail;
    if (state.detailLoading || !r) { $('#inbox-detail').innerHTML = `<div class="empty"><h3>${state.detailLoading ? '문의 내용을 확인하고 있어요' : '문의를 선택해 주세요'}</h3><p>문의 내용과 답변 이력을 이곳에서 확인할 수 있어요.</p></div>`; return; }
    const blocked = !r.canReply || uncertain(r) || completionUncertain(r);
    if (suggestions.has(r.id) && suggestions.get(r.id).fingerprint !== r.fingerprint) suggestions.delete(r.id);
    const historyNote = r.historyNote || (uncertain(r) ? '등록 결과는 판매자센터에서도 확인할 수 있습니다.' : '');
    $('#inbox-detail').innerHTML = `<div class="inbox-detail-head"><div><span class="eyebrow">${esc(labels[r.category])}</span><h3>${esc(r.title || '문의 내용')}</h3><p>${esc(r.store)} · ${esc(r.author || '고객')}${r.secret ? ' · 비밀 문의' : ''}</p>${isAbly ? `<span class="inbox-state ${esc(r.status)}">${esc(r.statusLabel || statuses[r.status])}</span>` : ''}</div><div class="inbox-detail-actions"><button id="inbox-detail-refresh" class="text-button">내용 새로고침</button>${isAbly && r.canComplete ? `<button id="inbox-complete" class="button secondary"${state.busy || uncertain(r) || completionUncertain(r) ? ' disabled' : ''}>문의 완료 처리</button>` : ''}</div></div>
      <p id="inbox-live-update" class="inbox-notice" role="status" hidden>새 메시지 또는 문의 상태 변경이 있습니다. 작성 중인 답변은 유지됩니다. <button id="inbox-load-latest" class="text-button">최신 내용 보기</button></p>
      ${r.product || r.orderNo ? `<dl class="inbox-product">${r.product ? `<div><dt>상품</dt><dd>${esc(r.product)}${r.option ? `<small>${esc(r.option)}</small>` : ''}</dd></div>` : ''}${r.orderNo ? `<div><dt>주문번호</dt><dd>${esc(r.orderNo)}</dd></div>` : ''}</dl>` : ''}
      ${historyNote ? `<p class="inbox-notice">${esc(historyNote)} <button id="inbox-original" class="text-button">판매자센터 열기 ↗</button></p>` : ''}
      ${isAbly ? `<div class="inbox-conversation-heading"><h3>대화 내용 <span>${r.messages.length}개</span></h3><button id="inbox-latest" class="text-button">최근 대화 보기 ↓</button></div>` : ''}
      <div class="inbox-messages" aria-label="대화 내용" tabindex="0">${r.messages.map(m => { const image = isAbly && safeInquiryImage(m.image); return `<article class="inbox-message ${esc(m.role)}"><header><strong>${m.role === 'seller' ? '판매자 답변' : m.role === 'system' ? '안내' : esc(r.author || '고객 문의')}</strong><time>${esc(date(m.date))}</time></header><p>${esc(m.text)}</p>${image ? `<a href="${esc(image)}" target="_blank" rel="noopener noreferrer" class="inbox-attachment"><img src="${esc(image)}" alt="문의 첨부 이미지" loading="lazy" referrerpolicy="no-referrer"><span>이미지 크게 보기 ↗</span></a>` : ''}</article>`; }).join('') || '<p class="inbox-notice">표시할 대화가 없습니다.</p>'}</div>
      <div class="inbox-composer">${blocked ? `<p class="inbox-notice${uncertain(r) || completionUncertain(r) ? ' has-error' : ''}">${completionUncertain(r) ? '완료 처리 결과를 확인 중입니다. 내용 새로고침으로 확인해 주세요.' : uncertain(r) ? '답변 등록 결과를 확인 중입니다. 내용 새로고침으로 확인해 주세요. 중복 등록은 차단됩니다.' : r.status === 'answered' ? '등록된 답변을 확인했습니다.' : '현재 답변할 수 없는 문의입니다.'}</p>` : `${r.replyMode !== 'confirm' ? '<div id="inbox-ai" class="inbox-ai"></div>' : ''}<label for="inbox-reply">답변 작성</label><textarea id="inbox-reply" rows="5" maxlength="${r.replyLimit}" placeholder="고객에게 전할 답변을 작성해 주세요.">${esc(draft(r))}</textarea><div class="inbox-composer-meta"><span id="inbox-save-status" role="status">${draft(r) ? '저장된 초안' : '초안은 자동으로 저장됩니다.'}</span><span id="inbox-length">${draft(r).length} / ${r.replyLimit}</span></div><button id="inbox-prepare" class="button primary">답변 확인 후 등록</button>`}</div>`;
    scopeIds();
    renderAI();
    if (r.replyMode === 'confirm' && !blocked) {
      $('#inbox-reply').readOnly = true; $('#inbox-reply').previousElementSibling.textContent = '확인완료 처리';
      $('#inbox-save-status').textContent = '쿠팡에서 지정한 확인완료 문구로 처리합니다.'; $('#inbox-prepare').textContent = '내용 확인 후 확인완료';
    }
    r.messages.forEach((m, index) => { if (m.label) root.querySelectorAll('.inbox-message header strong')[index].textContent = m.label; });
    if (isAbly) { const messages = root.querySelector('.inbox-messages'); messages.scrollTop = messages.scrollHeight; }
    $('#inbox-latest')?.addEventListener('click', () => { const messages = root.querySelector('.inbox-messages'); messages.scrollTop = messages.scrollHeight; messages.focus({ preventScroll: true }); });
    $('#inbox-complete')?.addEventListener('click', prepareCompletion);
    $('#inbox-detail-refresh').disabled = state.busy;
    $('#inbox-original')?.addEventListener('click', async () => { try { await api(`/api/inquiries/${platform}/open`, { category: r.category }); } catch (e) { error(e.message); } });
    $('#inbox-reply')?.addEventListener('input', event => {
      editVersions.set(r.id, (editVersions.get(r.id) || 0) + 1);
      state.edits.set(r.id, event.target.value); state.dirty.add(r.id);
      if (suggestions.get(r.id)?.mode === 'refine') { suggestions.delete(r.id); renderAI(); }
      if ($('#inbox-refine')) $('#inbox-refine').disabled = state.busy || generating.has(r.id) || !event.target.value.trim();
      $('#inbox-length').textContent = `${event.target.value.length} / ${r.replyLimit}`; $('#inbox-save-status').textContent = '초안 저장 중…';
      clearTimeout(state.timers.get(r.id)); state.timers.set(r.id, setTimeout(() => { void save(r.id).catch(() => {}); }, 450));
    });
    $('#inbox-prepare')?.addEventListener('click', prepare);
    $('#inbox-detail-refresh').addEventListener('click', () => { void select(r.id); });
    $('#inbox-load-latest').addEventListener('click', () => { void select(r.id); });
  }
  function renderAI() {
    const r = state.detail, panel = $('#inbox-ai'); if (!r) return;
    const working = generating.has(r.id), disabled = state.busy || working;
    if ($('#inbox-prepare')) $('#inbox-prepare').disabled = disabled;
    if ($('#inbox-complete')) $('#inbox-complete').disabled = disabled || uncertain(r) || completionUncertain(r);
    if (!panel) return;
    const suggestion = suggestions.get(r.id);
    panel.innerHTML = `<div class="inbox-ai-controls"><label for="inbox-tone">답변 말투<select id="inbox-tone"${disabled ? ' disabled' : ''}><option value="default">브랜드 기본 말투</option>${tones.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('')}<option value="custom">직접 설정하기</option></select></label><button id="inbox-generate" class="button secondary"${disabled ? ' disabled' : ''}>${working ? generating.get(r.id) === 'refine' ? '말투 다듬는 중…' : '대화를 읽고 초안 만드는 중…' : 'GPT 초안 만들기'}</button><button id="inbox-refine" class="button secondary"${disabled || !draft(r).trim() ? ' disabled' : ''}>내 초안 다듬기</button></div><label id="inbox-custom-tone-label" for="inbox-custom-tone"${tone !== 'custom' ? ' hidden' : ''}>원하는 말투<input id="inbox-custom-tone" maxlength="200" placeholder="예: 친절하고 간결하게, 확인이 필요한 부분은 정중하게" value="${esc(customTone)}"${disabled ? ' disabled' : ''}></label><p class="inbox-ai-help" role="status">${working ? '초안을 만드는 동안에도 답변을 작성할 수 있습니다.' : 'GPT 초안은 대화와 상품 정보를 참고합니다. 내 초안 다듬기는 핵심 내용에 맞춰 문장을 새로 다듬고, 인사와 공감 표현을 더합니다.'}</p>${suggestion ? `<section class="inbox-ai-suggestion" aria-label="GPT 답변 초안"><strong>${suggestion.mode === 'refine' ? '다듬은 초안' : 'GPT가 제안한 초안'}</strong><p>작성 중인 답변은 유지했습니다. 내용을 확인한 뒤 적용해 주세요.</p>${suggestion.mode === 'refine' ? `<details class="refinement-original"><summary>내가 쓴 초안 보기</summary><p>${esc(suggestion.sourceText)}</p></details>` : ''}<blockquote>${esc(suggestion.text)}</blockquote><div><button id="inbox-apply-suggestion" class="button secondary"${disabled ? ' disabled' : ''}>${suggestion.mode === 'refine' ? '다듬은 초안 적용' : '이 초안으로 바꾸기'}</button><button id="inbox-dismiss-suggestion" class="text-button"${disabled ? ' disabled' : ''}>닫기</button></div></section>` : ''}`;
    scopeIds(); $('#inbox-tone').value = tone;
    $('#inbox-tone').addEventListener('change', event => { tone = event.target.value; $('#inbox-custom-tone-label').hidden = tone !== 'custom'; });
    $('#inbox-custom-tone').addEventListener('input', event => { customTone = event.target.value; });
    $('#inbox-generate').addEventListener('click', () => { void generate(); });
    $('#inbox-refine').addEventListener('click', () => { void generate('refine'); });
    $('#inbox-dismiss-suggestion')?.addEventListener('click', () => { suggestions.delete(r.id); renderAI(); });
    $('#inbox-apply-suggestion')?.addEventListener('click', () => {
      if (state.busy || generating.has(r.id) || state.detail?.id !== r.id || suggestion.fingerprint !== state.detail.fingerprint) return;
      if (suggestion.mode === 'refine' && (suggestion.sourceText !== draft(r) || suggestion.sourceVersion !== (editVersions.get(r.id) || 0))) return;
      applySuggestion(r, suggestion.text); suggestions.delete(r.id); renderAI();
    });
  }
  function applySuggestion(r, text) {
    state.edits.set(r.id, text); state.dirty.add(r.id); editVersions.set(r.id, (editVersions.get(r.id) || 0) + 1);
    $('#inbox-reply').value = text; $('#inbox-length').textContent = `${text.length} / ${r.replyLimit}`; $('#inbox-save-status').textContent = 'GPT 초안 저장 중…';
    void save(r.id).catch(() => {}); renderList();
  }
  async function generate(mode = 'suggest') {
    const r = state.detail;
    if (!r?.canReply || r.replyMode === 'confirm' || state.busy || generating.has(r.id) || uncertain(r) || completionUncertain(r)) return;
    if (!aiConfigured()) { toast('브랜드 · GPT 설정에서 API 키를 연결해 주세요.', true); openAISettings?.(); return; }
    const chosenTone = tone === 'default' ? undefined : tone === 'custom' ? customTone.trim() : tone;
    if (chosenTone !== undefined && !chosenTone) { error('원하는 말투를 입력해 주세요.'); $('#inbox-custom-tone').focus(); return; }
    const version = editVersions.get(r.id) || 0, sourceText = draft(r), wasEmpty = !sourceText.trim();
    if (mode === 'refine' && wasEmpty) { error('다듬을 초안을 먼저 작성해 주세요.'); return; }
    generating.set(r.id, mode); error(); renderAI();
    try {
      const result = await api(endpoint(r.id, mode), { fingerprint: r.fingerprint, ...(chosenTone === undefined ? {} : { tone: chosenTone }), ...(mode === 'refine' ? { text: sourceText } : {}) });
      if (mode === 'refine' && ((editVersions.get(r.id) || 0) !== version || draft(r) !== sourceText)) { toast('작성 내용이 바뀌어 다듬은 결과를 적용하지 않았습니다. 다시 다듬어 주세요.'); return; }
      if (state.detail?.id === r.id && state.detail.fingerprint !== result.fingerprint) throw new Error('문의 내용이 변경되었습니다. 새로고침 후 다시 만들어 주세요.');
      if (mode !== 'refine' && state.detail?.id === r.id && !state.detailLoading && wasEmpty && !draft(state.detail).trim() && (editVersions.get(r.id) || 0) === version && $('#inbox-reply')) {
        applySuggestion(state.detail, result.text); suggestions.delete(r.id); toast('GPT 초안을 만들었습니다. 확인하고 수정한 뒤 등록해 주세요.');
      } else { suggestions.set(r.id, { ...result, mode, sourceText, sourceVersion: version }); toast(mode === 'refine' ? '말투를 다듬었습니다. 미리보기를 확인하고 적용해 주세요.' : 'GPT 초안을 만들었습니다. 문의의 추천 내용을 확인해 주세요.'); }
    } catch (e) { if (state.detail?.id === r.id) error(e.message); toast(e.message, true); }
    finally { generating.delete(r.id); if (state.detail?.id === r.id) renderAI(); }
  }
  function save(id) {
    clearTimeout(state.timers.get(id)); state.timers.delete(id);
    if (!state.dirty.has(id)) return state.saves.get(id) || Promise.resolve();
    const text = state.edits.get(id);
    const operation = (state.saves.get(id) || Promise.resolve()).catch(() => {}).then(() => api(endpoint(id, 'draft'), { text })).then(() => {
      if (state.edits.get(id) === text) state.dirty.delete(id);
      if (state.selected === id && $('#inbox-save-status')) $('#inbox-save-status').textContent = state.dirty.has(id) ? '초안 저장 중…' : '초안 저장됨';
    }).catch(e => { if (state.selected === id && $('#inbox-save-status')) $('#inbox-save-status').textContent = '저장 실패 · 작성 내용은 유지됩니다.'; toast(e.message, true); throw e; });
    state.saves.set(id, operation); return operation;
  }
  async function select(id) {
    if (state.busy) return;
    if (state.selected) void save(state.selected).catch(() => {});
    const generation = ++state.detailGeneration;
    state.selected = id; state.detail = null; state.detailLoading = true; error(); renderList(); renderDetail();
    try {
      const r = await api(endpoint(id, 'detail'), {}); if (generation !== state.detailGeneration) return;
      state.detail = r; state.records = state.records.map(item => item.id === id ? r : item);
      if (isAbly && r.completionAttempt?.state === 'completed' && r.status === 'answered') applyCompletion(r);
      if (r.attempt?.state === 'sent' && !state.dirty.has(id)) state.edits.delete(id);
    } catch (e) { if (generation === state.detailGeneration) error(e.message); }
    finally { if (generation === state.detailGeneration) { state.detailLoading = false; renderList(); renderDetail(); if (isAbly && state.detail && !root.closest('[hidden]') && window.innerWidth <= 1000) $('#inbox-detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); } }
  }
  async function open(category, { status, selectFirst = false } = {}) {
    if (!labels[category] || state.busy) return;
    root.hidden = false;
    if (state.selected) void save(state.selected).catch(() => {});
    const changed = category !== state.category, generation = ++state.generation;
    ++state.detailGeneration; state.detailLoading = false; state.loading = true; state.category = category;
    if (changed) { state.records = []; state.detail = null; state.selected = null; state.checkedAt = ''; state.store = ''; $('#inbox-search').value = ''; }
    if (status && ['all', 'pending', 'answered', 'draft', 'closed'].includes(status)) { $('#inbox-status').value = status; $('#inbox-search').value = ''; }
    error();
    for (const button of document.querySelectorAll(`[data-${prefix}inquiry-category]`)) { const active = button.getAttribute(`data-${prefix}inquiry-category`) === category; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); }
    renderList(); renderDetail();
    try {
      const result = await api(`/api/inquiries/${platform}/list`, { category, period: state.period }); if (generation !== state.generation) return;
      state.records = result.records; state.store = result.store; state.checkedAt = result.checkedAt;
      const selected = selectFirst ? result.records.find(r => !status || status === 'all' || r.status === status)?.id : result.records.find(r => r.id === state.selected)?.id || (isAbly ? result.records[0]?.id : null);
      state.detail = null; state.selected = null;
      if (selected) void select(selected);
    } catch (e) { if (generation === state.generation) { if (e.code === 'STORE_CHANGED') { state.records = []; state.detail = null; state.selected = null; } error(e.message + (state.records.length ? ' 이전 조회 내용을 표시합니다.' : '')); } }
    finally { if (generation === state.generation) { state.loading = false; renderList(); renderDetail(); if (isAbly && changed) root.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }
  }
  async function refresh() {
    // Background refresh must not replace the editor, its selection, or a confirmation in progress.
    if (!state.category || refreshing || state.loading || state.detailLoading || state.busy || dialog.open || generating.size || root.closest('[hidden]')) return;
    const generation = state.generation, revision = refreshRevision, category = state.category, period = state.period;
    refreshing = true;
    try {
      const result = await api(`/api/inquiries/${platform}/list`, { category, period });
      if (generation !== state.generation || revision !== refreshRevision || state.busy || dialog.open) return;
      if (refreshError && $('#inbox-error').textContent === refreshError) error();
      refreshError = '';
      state.records = result.records; state.store = result.store; state.checkedAt = result.checkedAt; renderList();
      const selected = state.selected, detailGeneration = state.detailGeneration;
      if (!selected || !state.detail || state.detailLoading || state.busy || dialog.open || generating.size) return;
      const latest = await api(endpoint(selected, 'detail'), {});
      if (generation !== state.generation || revision !== refreshRevision || detailGeneration !== state.detailGeneration || state.detail?.id !== selected) return;
      if (latest.fingerprint !== state.detail.fingerprint) {
        const notice = $('#inbox-live-update'); if (notice) notice.hidden = false;
      }
    } catch (e) { if (generation === state.generation && revision === refreshRevision) { refreshError = e.message + ' 이전 조회 내용을 표시합니다.'; error(refreshError); } }
    finally { refreshing = false; }
  }
  async function prepare() {
    const r = state.detail; if (!r || state.busy || generating.has(r.id)) return;
    refreshRevision++;
    state.busy = true; $('#inbox-prepare').disabled = true; $('#inbox-reply').disabled = true; error();
    try {
      await save(r.id);
      intent = await api(endpoint(r.id, 'prepare'), { text: draft(r), fingerprint: r.fingerprint });
      const target = intent.inquiry;
      $('#inbox-confirm-body').innerHTML = `<p class="inbox-confirm-target">${esc(target.store)} · ${esc(labels[target.category])}<br>${esc(target.author)}${target.product ? ' · ' + esc(target.product) : ''}</p><h3>고객 문의</h3><p class="inbox-confirm-question">${esc(target.content || target.title)}</p><h3>등록할 답변</h3><p id="inbox-confirm-text">${esc(intent.text)}</p>`;
      scopeIds();
      dialog.querySelector('h2').textContent = target.replyMode === 'confirm' ? '확인완료로 처리할까요?' : '이 답변을 등록할까요?';
      $('#inbox-confirm-send').textContent = target.replyMode === 'confirm' ? '확인완료 처리' : '답변 등록';
      dialog.showModal();
    } catch (e) { error(e.message); }
    finally { state.busy = false; renderList(); if ($('#inbox-prepare')) $('#inbox-prepare').disabled = false; if ($('#inbox-reply')) $('#inbox-reply').disabled = false; }
  }
  async function prepareCompletion() {
    const r = state.detail; if (!isAbly || !r?.canComplete || state.busy || generating.has(r.id) || completionUncertain(r) || uncertain(r)) return;
    refreshRevision++;
    state.busy = true; $('#inbox-complete').disabled = true; error();
    try {
      await save(r.id);
      const result = await api(endpoint(r.id, 'complete-prepare'), { fingerprint: r.fingerprint });
      intent = { ...result, action: 'complete' };
      const target = result.inquiry;
      $('#inbox-confirm-body').innerHTML = `<p class="inbox-confirm-target">${esc(target.store)} · ${esc(labels[target.category])}<br>${esc(target.author)}${target.product ? ' · ' + esc(target.product) : ''}</p><h3>최근 고객 문의</h3><p class="inbox-confirm-question">${esc(target.content || target.title)}</p><p>이 문의를 에이블리에서 완료 처리합니다. 미완료 목록에서 제외되며 대화 이력은 보관됩니다.</p>${draft(r).trim() ? '<p class="inbox-notice">작성 중인 답변은 전송되지 않고 초안으로 보관됩니다.</p>' : ''}`;
      dialog.querySelector('h2').textContent = '이 문의를 완료 처리할까요?'; $('#inbox-confirm-send').textContent = '문의 완료 처리'; dialog.showModal();
    } catch (e) { error(e.message); }
    finally { state.busy = false; if ($('#inbox-complete')) $('#inbox-complete').disabled = false; }
  }
  function applyCompletion(record) {
    state.detail = record;
    state.records = state.records.map(r => r.id === record.id ? record : r).filter(r => state.period !== 'pending' || r.status === 'pending');
    onSent?.();
  }
  async function completeConfirmed(approved) {
    publishing = true; state.busy = true;
    for (const b of dialog.querySelectorAll('button')) b.disabled = true;
    $('#inbox-confirm-send').textContent = '완료 처리 확인 중…';
    try {
      const result = await api(endpoint(approved.inquiry.id, 'complete'), { token: approved.token });
      applyCompletion(result.inquiry); toast('에이블리 문의를 완료 처리했습니다.');
    } catch (e) {
      error(e.message);
      if (state.detail && e.code === 'INQUIRY_COMPLETION_UNCERTAIN') state.detail.completionAttempt = { state: 'uncertain' };
      try {
        const record = await api(endpoint(approved.inquiry.id, 'detail'), {}); state.detail = record;
        if (record.completionAttempt?.state === 'completed' && record.status === 'answered') { applyCompletion(record); error(); toast('문의 완료 처리를 확인했습니다.'); }
      } catch {}
    } finally {
      publishing = false; state.busy = false; dialog.close(); for (const b of dialog.querySelectorAll('button')) b.disabled = false;
      $('#inbox-confirm-send').textContent = '답변 등록'; renderList(); renderDetail();
    }
  }
  async function publish() {
    if (!intent || publishing) return;
    const approved = intent; intent = null;
    if (approved.action === 'complete') return completeConfirmed(approved);
    publishing = true; state.busy = true;
    for (const b of dialog.querySelectorAll('button')) b.disabled = true;
    $('#inbox-confirm-send').textContent = '등록 확인 중…';
    try {
      const result = await api(endpoint(approved.inquiry.id, 'publish'), { token: approved.token });
      state.detail = result.inquiry; state.edits.delete(result.inquiry.id); state.dirty.delete(result.inquiry.id);
      state.records = state.records.map(r => r.id === result.inquiry.id ? result.inquiry : r);
      toast(`${platformName}에 ${approved.inquiry.replyMode === 'confirm' ? '확인완료로 처리했습니다.' : '답변을 등록했습니다.'}`); onSent?.();
    } catch (e) {
      error(e.message);
      if (state.detail && e.code === 'INQUIRY_UNCERTAIN') state.detail.attempt = { state: 'uncertain' };
      try { const r = await api(endpoint(approved.inquiry.id, 'detail'), {}); state.detail = r; state.records = state.records.map(item => item.id === r.id ? r : item); if (r.attempt?.state === 'sent') { state.edits.delete(r.id); toast('답변 등록을 확인했습니다.'); onSent?.(); error(); } } catch {}
    } finally {
      publishing = false; state.busy = false; dialog.close(); for (const b of dialog.querySelectorAll('button')) b.disabled = false;
      $('#inbox-confirm-send').textContent = '답변 등록'; renderList(); renderDetail();
    }
  }
  $('#inbox-list').addEventListener('click', event => { const button = event.target.closest('[data-inbox-id]'); if (button) void select(button.dataset.inboxId); });
  $('#inbox-search').addEventListener('input', renderList); $('#inbox-status').addEventListener('change', renderList);
  $('#inbox-period').addEventListener('change', event => { state.period = event.target.value; void open(state.category); });
  $('#inbox-refresh').addEventListener('click', () => { void open(state.category); });
  for (const selector of ['#inbox-confirm-x', '#inbox-confirm-cancel']) $(selector).addEventListener('click', () => { if (!publishing) { intent = null; dialog.close(); } });
  $('#inbox-confirm-send').addEventListener('click', publish);
  dialog.addEventListener('cancel', event => { if (publishing) event.preventDefault(); else intent = null; });
  window.addEventListener('beforeunload', event => { if (state.dirty.size || publishing) { event.preventDefault(); event.returnValue = ''; } });
  return { open, refresh };
}
