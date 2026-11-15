import { SerialQueue, sortReviews, reviewPlatform, AppError, collectReviews } from './core.js';

export class AblyReviewService {
  queue = new SerialQueue();
  constructor(store, connector) { this.store = store; this.connector = connector; }
  async sync(period, options) {
    return this.queue.run(async () => {
      const result = await collectReviews(this.store, this.connector, 'ably', period, options);
      if (!Array.isArray(result.reviews) || result.reviews.length !== result.total || new Set(result.reviews.map(r => r.id)).size !== result.total || result.reviews.some(r => !/^ably-\d+$/.test(r.id))) throw new AppError('에이블리 리뷰 일부를 읽지 못했습니다. 기존 목록은 유지됩니다.', 502, 'INCOMPLETE_SYNC');
      await this.store.update(s => {
        s.reviews = sortReviews([...s.reviews.filter(r => reviewPlatform(r) !== 'ably'), ...result.reviews.map(r => ({ ...r, platform: 'ably', readOnly: true }))]);
        s.lastSync = new Date().toISOString();
        s.syncs = { ...s.syncs, ably: { ...result, reviews: undefined, lastSync: s.lastSync } };
      });
      return this.store.data;
    });
  }
}
