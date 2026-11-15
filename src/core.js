import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { deliveryPlatforms, replyPlatforms, platformLabels } from '../public/platforms.js';
import {collectCachedReviews,commitReviewCache,hydrateReviewCache,retainReviewArchive,selectCachedPeriod} from './review-cache.js';

export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
export const fingerprint = r => createHash('sha256').update(JSON.stringify([r.id, r.productId, r.content, r.rating, r.store])).digest('hex');
export const reviewPlatform = r => r.platform || 'naver';
export const replyLimit = review => reviewPlatform(review).startsWith('coupangeats-') ? 300 : 1000;
export function assertReplyable(review) {
  if (!replyPlatforms.includes(reviewPlatform(review)) || review.readOnly === true) throw new AppError('이 스토어의 리뷰는 조회 전용입니다. 답글 작성·추천·등록은 지원하지 않습니다.', 403, 'READ_ONLY_REVIEW');
}
export function sortReviews(reviews) {
  const timestamp = r => {
    if (Number.isFinite(r.dateTimestamp)) return r.dateTimestamp;
    const parts = r.date?.match(/(\d{4})[.-](\d{2})[.-](\d{2})(?:[.\s]+(\d{2}):(\d{2}))?/);
    return parts ? Date.parse(`${parts[1]}-${parts[2]}-${parts[3]}T${parts[4] || '00'}:${parts[5] || '00'}:00+09:00`) : 0;
  };
  return reviews.sort((a, b) => timestamp(b) - timestamp(a) || String(b.id).localeCompare(String(a.id)));
}
export function validateReply(text, maxLength = 1000) {
  if (typeof text !== 'string' || text.trim().length < 5 || text.trim().length > maxLength) throw new AppError(`답글은 5~${maxLength.toLocaleString('ko-KR')}자로 작성해 주세요.`);
  return text.trim();
}
export function assertSameReview(expected, actual) {
  if (!actual || fingerprint(expected) !== fingerprint(actual)) throw new AppError('리뷰 또는 스토어가 변경되었습니다. 목록을 새로고침한 뒤 확인해 주세요.', 409, 'REVIEW_CHANGED');
}
const sameReply = (a, b) => a.replace(/\r\n?/g, '\n').trim() === b.replace(/\r\n?/g, '\n').trim();
function reconcileSubmissionRecords(state, review) {
  if (!review.hasReply) return;
  delete state.drafts[review.id];
  const exactKey = typeof review.reply === 'string' ? `${review.id}:${createHash('sha256').update(review.reply.trim()).digest('hex')}` : null;
  for (const [key, attempt] of Object.entries(state.submissions)) {
    if (attempt.reviewId === review.id && ['attempting', 'uncertain'].includes(attempt.state)) {
      attempt.state = key === exactKey ? 'sent' : 'confirmed'; attempt.confirmedAt = new Date().toISOString();
    }
  }
}
export class SerialQueue {
  tail = Promise.resolve();
  pending = 0;
  get busy() { return this.pending > 0; }
  run(fn) { this.pending++; const result = this.tail.then(fn, fn).finally(() => { this.pending--; }); this.tail = result.catch(() => {}); return result; }
}
export async function collectReviews(store, connector, platform, period, { automatic = false, shouldRun, ...options } = {}) {
  if (automatic && shouldRun && !shouldRun()) throw new AppError('자동 가져오기를 중지했습니다.', 409, 'AUTO_SYNC_CANCELLED');
  const previous = store.data.syncs?.[platform] || (platform === 'naver' ? store.data.sync : null);
  // Resolve inside the service queue so a newer manual period always wins.
  if (automatic) period = store.data.reviewPeriod || previous?.period || '3m';
  if (automatic && previous?.store) {
    const status = await connector.status();
    if (status.connected && status.store && status.store !== previous.store) throw new AppError('연결된 판매자 계정이 변경되었습니다. 스토어를 확인하고 직접 리뷰를 가져와 주세요.', 409, 'STORE_CHANGED');
  }
  if (automatic && shouldRun && !shouldRun()) throw new AppError('자동 가져오기를 중지했습니다.', 409, 'AUTO_SYNC_CANCELLED');
  const result = connector.syncRange||connector.syncChanges ? await collectCachedReviews(store,connector,platform,period||'3m',{...options,automatic}) : await connector.sync(period);
  if (automatic && previous?.store && result.store !== previous.store) throw new AppError('조회 중 판매자 계정이 변경되었습니다. 기존 리뷰를 유지합니다.', 409, 'STORE_CHANGED');
  return result;
}
export class Store {
  constructor(directory) { this.directory = directory; this.queue = new SerialQueue(); this.data = { reviews: [], drafts: {}, submissions: {}, lastSync: null, sync: null, syncs: {}, autoSync: { enabled: true, intervalMinutes: 10 }, settings: { brand: '티웨스트', tone: '따뜻하고 정중하게', guidance: '', model: 'gpt-5-mini' } }; }
  async init() { await mkdir(this.directory, { recursive: true }); try { const saved = JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8')); this.data = { ...this.data, ...saved, settings: { ...this.data.settings, ...saved.settings } }; } catch (e) { if (e.code !== 'ENOENT') throw new Error('저장된 데이터 파일을 읽을 수 없습니다. .local/state.json을 확인해 주세요.'); } hydrateReviewCache(this.data); }
  async update(fn) { return this.queue.run(async () => { const result = fn(this.data); retainReviewArchive(this.data); const p = path.join(this.directory, 'state.json'); await writeFile(`${p}.tmp`, JSON.stringify(this.data, null, 2), 'utf8'); await rename(`${p}.tmp`, p); return result; }); }
  review(id) { const r = this.data.reviews.find(r => r.id === id) || this.data.reviewArchive?.find(r => r.id === id && !r.sourceRemovedAt && r.store === this.data.reviewCache?.[reviewPlatform(r)]?.store); if (!r) throw new AppError('리뷰를 찾을 수 없습니다. 먼저 동기화해 주세요.', 404); return r; }
}

// Publishing is reachable only from the human-confirmed POST route, never from AI generation or sync.
export class ReviewService {
  queue = new SerialQueue();
  constructor(store, connector, ai, platform = 'naver', queue = new SerialQueue()) { this.store = store; this.connector = connector; this.ai = ai; this.platform = platform; this.queue = queue; this.intents = new Map(); }
  async sync(period, options) {
    return this.queue.run(async () => {
      const result = await collectReviews(this.store, this.connector, this.platform, period, options);
      if (this.platform !== 'naver' && (result.reviews.length !== result.total || new Set(result.reviews.map(r => r.id)).size !== result.total || result.reviews.some(r => r.platform !== this.platform || !r.id.startsWith(`${this.platform}-`) || r.store !== result.store))) throw new AppError('매장별 리뷰 조회 결과를 확인하지 못했습니다. 기존 목록을 유지합니다.', 502, 'INCOMPLETE_SYNC');
      await this.store.update(s => {
        commitReviewCache(s,this.platform,result);
        const previous = new Map(s.reviews.map(r => [r.id, r]));
        const incoming = result.reviews.map(r => ({ ...r, platform: this.platform, readOnly: false, reply: r.hasReply ? (r.reply ?? previous.get(r.id)?.reply ?? null) : null, fingerprint: fingerprint(r) }));
        s.reviews = sortReviews([...incoming, ...s.reviews.filter(r => reviewPlatform(r) !== this.platform)]);
        s.lastSync = new Date().toISOString();
        const metadata = { ...result, reviews: undefined, cacheUpdate:undefined, lastSync: s.lastSync };
        if (this.platform === 'naver') s.sync = metadata;
        s.syncs = { ...s.syncs, [this.platform]: metadata };
        for (const r of s.reviews) reconcileSubmissionRecords(s, r);
        if(result.cacheUpdate&&s.reviewPeriod&&s.reviewPeriod!==period)selectCachedPeriod(s,this.platform,s.reviewPeriod,options?.now);
      });
      return this.store.data;
    });
  }
  async readAndReconcile(expected) {
    const actual = await this.connector.detail(expected); assertSameReview(expected, actual);
    await this.store.update(s => {
      for(const review of [...s.reviews,...s.reviewArchive].filter(r=>r.id===expected.id&&r.store===expected.store)) {
        Object.assign(review, { hasReply: actual.hasReply, reply: actual.reply, option: actual.option, detailCheckedAt: new Date().toISOString() });
        reconcileSubmissionRecords(s, review);
      }
    });
    return this.store.review(expected.id);
  }
  async detail(id) {
    if (!replyPlatforms.includes(reviewPlatform(this.store.review(id))) || this.store.review(id).readOnly === true) return this.store.review(id);
    if (reviewPlatform(this.store.review(id)) !== this.platform) throw new AppError('선택한 매장이 다릅니다.', 409, 'STORE_CHANGED');
    return this.queue.run(() => this.readAndReconcile(this.store.review(id)));
  }
  async suggest(id, tone) {
    const review = this.store.review(id);
    assertReplyable(review);
    if (reviewPlatform(review) !== this.platform) throw new AppError('선택한 매장이 다릅니다.',409,'STORE_CHANGED');
    if (review.hasReply) throw new AppError('이미 답글이 등록된 리뷰입니다.', 409, 'ALREADY_REPLIED');
    if (tone !== undefined && (typeof tone !== 'string' || !tone.trim() || tone.trim().length > 200)) throw new AppError('추천 말투는 1~200자로 입력해 주세요.', 400, 'INVALID_TONE');
    const delivery = deliveryPlatforms[this.platform];
    const preferences = delivery ? this.store.data.settings.delivery?.[this.platform] || { tone:'따뜻하고 정중하게', guidance:'' } : this.store.data.settings;
    const settings = { ...this.store.data.settings, ...preferences, brand: delivery?.brand || this.store.data.settings.brand, tone: tone === undefined ? preferences.tone : tone.trim() };
    return { text: validateReply(await this.ai.generate(review, settings), replyLimit(review)), tone: settings.tone };
  }
  prepare(id, text, expectedFingerprint, token) {
    const r = this.store.review(id); assertReplyable(r); text = validateReply(text, replyLimit(r));
    if (reviewPlatform(r) !== this.platform) throw new AppError('선택한 매장이 다릅니다.',409,'STORE_CHANGED');
    if (r.replyAllowed === false && !r.hasReply) throw new AppError('해당 서비스에서 이 리뷰의 답글 등록을 허용하지 않습니다.',409,'REPLY_UNAVAILABLE');
    if (r.hasReply) throw new AppError('이미 답글이 등록된 리뷰입니다.', 409, 'ALREADY_REPLIED');
    if (fingerprint(r) !== expectedFingerprint) throw new AppError('리뷰가 변경되었습니다. 다시 확인해 주세요.', 409);
    this.intents.set(token, { id, text, fingerprint: expectedFingerprint, expires: Date.now() + 5 * 60_000 });
    for (const [key, intent] of this.intents) if (intent.expires < Date.now()) this.intents.delete(key);
    return { token, review: { id: r.id, product: r.product, content: r.content, author: r.author }, text };
  }
  async publish(id, token) {
    const intent = this.intents.get(token); this.intents.delete(token);
    if (!intent || intent.id !== id || intent.expires < Date.now()) throw new AppError('등록 확인 시간이 지났습니다. 내용을 확인한 뒤 다시 등록해 주세요.', 409, 'INVALID_INTENT');
    return this.queue.run(async () => {
      const expected = this.store.review(id);
      assertReplyable(expected);
      if (reviewPlatform(expected) !== this.platform) throw new AppError('선택한 매장이 다릅니다.',409,'STORE_CHANGED');
      if (fingerprint(expected) !== intent.fingerprint) throw new AppError('리뷰가 변경되었습니다.', 409, 'REVIEW_CHANGED');
      if (expected.hasReply) throw new AppError('이미 답글이 등록된 리뷰입니다.', 409, 'ALREADY_REPLIED');
      const attemptKey = `${id}:${createHash('sha256').update(intent.text).digest('hex')}`;
      const previous = this.store.data.submissions[attemptKey];
      if (Object.values(this.store.data.submissions).some(a => a.reviewId === id && ['attempting','uncertain'].includes(a.state))) throw new AppError('이 리뷰의 이전 등록 결과가 아직 확인되지 않았습니다. 답글 확인을 눌러 주세요.',409,'DUPLICATE_ATTEMPT');
      if (previous && ['attempting', 'uncertain', 'sent'].includes(previous.state)) throw new AppError('이 답글의 등록을 이미 요청했습니다. 새로고침하거나 기존 답글을 확인해 주세요.', 409, 'DUPLICATE_ATTEMPT');
      let attempted = false;
      try {
        const result = await this.connector.publish(expected, intent.text, async () => {
          attempted = true;
          await this.store.update(s => { s.submissions[attemptKey] = { reviewId: id, state: 'attempting', time: new Date().toISOString() }; });
        });
        await this.store.update(s => {
          for(const review of [...s.reviews,...s.reviewArchive].filter(r=>r.id===id&&r.store===expected.store))Object.assign(review, { hasReply: true, reply: result.reply, repliedAt: new Date().toISOString() });
          delete s.drafts[id]; s.submissions[attemptKey] = { reviewId: id, state: 'sent', time: new Date().toISOString() };
        });
        return { success: true, review: this.store.review(id) };
      } catch (error) {
        if (attempted) {
          await this.store.update(s => { s.submissions[attemptKey] = { reviewId: id, state: 'uncertain', time: new Date().toISOString() }; });
          // The click may have succeeded even if the notice/read-back failed.
          // Recover by reading the same review; never send the reply again.
          const verified = await this.readAndReconcile(expected).catch(() => null);
          if (verified?.hasReply) {
            if (sameReply(verified.reply || '', intent.text)) return { success: true, review: verified, reconciled: true };
            throw new AppError(`${platformLabels[this.platform]}에 등록된 답글이 요청한 내용과 달라, 실제 등록된 내용을 앱에 반영했습니다. 답글을 확인해 주세요.`, 409, 'REPLY_MISMATCH');
          }
          throw new AppError(`등록 요청 후 결과를 확인하지 못했습니다. 중복 등록을 막기 위해 자동 재전송하지 않습니다. ${platformLabels[this.platform]} 답글 확인을 눌러 주세요.`, 409, 'RESULT_UNCERTAIN');
        }
        throw error;
      }
    });
  }
}
