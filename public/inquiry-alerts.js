const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stores = {
  naver: { name: '네이버', mark: 'N', categories: { talktalk: '톡톡 문의', customer: '주문 고객 문의', product: '상품 Q&A', center: '고객센터' } },
  coupang: { name: '쿠팡', mark: 'C', categories: { center: '고객센터 문의', customer: '고객문의' } },
  ably: { name: '에이블리', mark: 'A', categories: { goods: '상품 문의', order_before_delivery: '배송 전 변경·취소', order_after_delivery: '교환·반품', order_etc: '배송·기타·결제', etc: '기타 문의', place: '플레이스 문의', affiliate_sponsorship: '협찬 문의' } },
};

export function createInquiryAlerts({ root, getState, onRefresh, onOpen }) {
  const categoriesHTML = new Map();
  root.querySelector('.inquiry-alert-cards').innerHTML = Object.entries(stores).map(([platform, store]) => `<article class="inquiry-alert-card" data-alert-card="${platform}"><button class="inquiry-alert-store" data-alert-platform="${platform}" aria-label="${store.name} 문의함 열기"><span class="inquiry-alert-mark ${platform}">${store.mark}</span><span class="inquiry-alert-name">${store.name}<small data-alert-status>확인 전</small></span><strong data-alert-count>—</strong><span class="inquiry-alert-arrow" aria-hidden="true">›</span></button><div class="inquiry-alert-categories"></div></article>`).join('');
  function render() {
    const infos = getState(); let total = 0, known = 0, busy = false;
    const dates = [];
    for (const [platform, store] of Object.entries(stores)) {
      const info = infos[platform], card = root.querySelector(`[data-alert-card="${platform}"]`), items = info?.summary?.items;
      const valid = !info?.error && Array.isArray(items) && Object.keys(store.categories).every(id => items.some(item => item.id === id && Number.isSafeInteger(item.count) && item.count >= 0));
      const pending = valid ? items.filter(item => store.categories[item.id] && item.count > 0) : [], count = valid ? pending.reduce((sum, item) => sum + item.count, 0) : null;
      busy ||= Boolean(info?.loading);
      if (valid) { known++; total += count; if (Number.isFinite(Date.parse(info.summary.checkedAt))) dates.push(Date.parse(info.summary.checkedAt)); }
      card.classList.toggle('has-inquiries', count > 0); card.classList.toggle('has-error', Boolean(info?.error));
      card.querySelector('[data-alert-count]').textContent = count === null ? '—' : count.toLocaleString('ko-KR');
      const status = info?.error ? info.loginRequired ? '연결 확인 필요' : '조회 실패 · 다시 확인' : count === null ? info?.loading ? '문의 확인 중…' : '확인 전' : count > 0 ? '확인할 문의' : '확인할 문의 없음';
      card.querySelector('[data-alert-status]').textContent = status;
      card.querySelector('.inquiry-alert-store').title = info?.error || `${store.name} ${status}${count === null ? '' : ' ' + count + '건'}`;
      const html = pending.map(item => `<button class="inquiry-alert-category" data-alert-platform="${platform}" data-alert-category="${item.id}">${escape(store.categories[item.id])}<strong>${item.count.toLocaleString('ko-KR')}</strong><span aria-hidden="true">↗</span></button>`).join('');
      if (categoriesHTML.get(platform) !== html) { card.querySelector('.inquiry-alert-categories').innerHTML = html; categoriesHTML.set(platform, html); }
    }
    root.classList.toggle('has-inquiries', total > 0);
    root.querySelector('#inquiry-alert-total').textContent = total > 0 ? `${known === 3 ? '' : '확인된 문의 '}${total.toLocaleString('ko-KR')}건` : known === 3 ? '모두 확인했어요' : '확인 중';
    root.querySelector('#inquiry-alert-description').textContent = total > 0 ? '문의 종류를 누르면 답변 대기 문의가 바로 열립니다.' : known === 3 ? '지금은 확인할 문의가 없습니다. 새 문의가 들어오면 여기에 표시합니다.' : '스토어의 문의 상태를 확인해 주세요. 조회하지 못한 건수는 —로 표시합니다.';
    root.querySelector('#inquiry-alert-refresh').disabled = busy;
    root.querySelector('#inquiry-alert-time').textContent = busy ? '새 문의 확인 중…' : dates.length ? `${new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date(Math.min(...dates)))} 확인 · 30초 자동 확인` : '30초마다 자동 확인';
  }
  root.querySelector('#inquiry-alert-refresh').addEventListener('click', () => { void onRefresh(); });
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-alert-platform]'); if (!button) return;
    const platform = button.dataset.alertPlatform, category = button.dataset.alertCategory;
    if (!stores[platform] || (category && !stores[platform].categories[category])) return;
    void onOpen(platform, category);
  });
  render();
  return { render };
}
