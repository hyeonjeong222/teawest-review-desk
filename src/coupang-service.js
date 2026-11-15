import { SerialQueue, sortReviews, reviewPlatform, AppError, collectReviews } from './core.js';
import {commitReviewCache,selectCachedPeriod} from './review-cache.js';
export class CoupangReviewService {
  queue = new SerialQueue();
  constructor(store, connector) { this.store = store; this.connector = connector; }
  async sync(period, options) {
    return this.queue.run(async () => {
      const result = await collectReviews(this.store, this.connector, 'coupang', period, options);
      if (result.reviews.length !== result.total || new Set(result.reviews.map(r => r.id)).size !== result.total || result.reviews.some(r => !/^coupang-\d+$/.test(r.id))) throw new AppError('쿠팡 리뷰 조회 결과를 확인하지 못했습니다.', 502, 'INCOMPLETE_SYNC');
      await this.store.update(s => {
        commitReviewCache(s,'coupang',result);
        s.reviews = sortReviews([...s.reviews.filter(r => reviewPlatform(r) !== 'coupang'), ...result.reviews.map(r => ({ ...r, platform: 'coupang', readOnly: true, hasReply: false, reply: null }))]);
        s.lastSync = new Date().toISOString();
        s.syncs = { ...s.syncs, coupang: { ...result, reviews: undefined, cacheUpdate:undefined, lastSync: s.lastSync } };
        if(result.cacheUpdate&&s.reviewPeriod&&s.reviewPeriod!==period)selectCachedPeriod(s,'coupang',s.reviewPeriod,options?.now);
      });
      return this.store.data;
    });
  }
}
