export const deliveryPlatforms = {
  'baemin-teawest': { label: '배민 · 티웨스트', provider: 'baemin', providerLabel: '배민', brand: '티웨스트', home: 'https://self.baemin.com/' },
  'baemin-besti': { label: '배민 · 베스티', provider: 'baemin', providerLabel: '배민', brand: '베스티', home: 'https://self.baemin.com/' },
  'coupangeats-teawest': { label: '쿠팡이츠 · 티웨스트', provider: 'coupangeats', providerLabel: '쿠팡이츠', brand: '티웨스트', home: 'https://store.coupangeats.com/merchant/login' },
  'coupangeats-besti': { label: '쿠팡이츠 · 베스티', provider: 'coupangeats', providerLabel: '쿠팡이츠', brand: '베스티', home: 'https://store.coupangeats.com/merchant/login' },
};
export const platformLabels = { naver: '네이버', coupang: '쿠팡윙', ably: '에이블리', ...Object.fromEntries(Object.entries(deliveryPlatforms).map(([id, value]) => [id, value.label])) };
export const platforms = Object.keys(platformLabels);
export const replyPlatforms = ['naver', ...Object.keys(deliveryPlatforms)];
export const effectiveReviewPeriod = (_platform, period) => period;
