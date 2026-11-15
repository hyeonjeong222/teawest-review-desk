import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { cleanupTestDirectory } from './cleanup.js';
import os from 'node:os';
import path from 'node:path';
import { Store, ReviewService, AppError, fingerprint, validateReply, assertSameReview } from '../src/core.js';
import { redact } from '../src/ai.js';
const review = { id: '1234567890', productId: '1234', product: '테스트 상품', content: '식감이 좋고 맛있어요.', rating: 5, store: '테스트 스토어', hasReply: false };
async function setup(t, publish) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-desk-test-')); t.after(() => cleanupTestDirectory(dir));
  const store = new Store(dir); await store.init(); await store.update(s => { s.reviews = [{ ...review, fingerprint: fingerprint(review) }]; });
  let calls = 0;
  const connector = { sync: async () => ({ reviews: [{ ...review }], total: 1 }), detail: async () => ({ ...review }), publish: async (r, text, beforeClick) => { calls++; await beforeClick(); if (publish) return publish(r, text); return { reply: text }; } };
  return { store, service: new ReviewService(store, connector, { generate: async () => '소중한 후기 감사합니다!' }), count: () => calls };
}
test('sync and GPT suggestions never publish; edited text is published only with a single-use intent', async t => {
  const { store, service, count } = await setup(t);
  await service.sync('3m'); const suggestion = await service.suggest(review.id); assert.equal(suggestion.text, '소중한 후기 감사합니다!'); assert.equal(count(), 0);
  const edited = '식감을 좋아해 주셔서 감사합니다. 달콤한 하루 보내세요!';
  const intent = service.prepare(review.id, edited, fingerprint(review), 'human-confirmation'); assert.equal(count(), 0);
  const result = await service.publish(review.id, intent.token); assert.equal(result.review.reply, edited); assert.equal(count(), 1); assert.equal(store.data.reviews[0].hasReply, true);
  await assert.rejects(service.publish(review.id, intent.token), e => e.code === 'INVALID_INTENT'); assert.equal(count(), 1);
});
test('publishing without a human-confirmed intent fails before touching Naver', async t => {
  const { service, count } = await setup(t); await assert.rejects(service.publish(review.id, 'invented-token'), e => e.code === 'INVALID_INTENT'); assert.equal(count(), 0);
});
test('expired and wrong-review intents cannot publish', async t => {
  const { service, count } = await setup(t); service.prepare(review.id, '후기 감사합니다.', fingerprint(review), 'expired'); service.intents.get('expired').expires = 0;
  await assert.rejects(service.publish(review.id, 'expired')); service.prepare(review.id, '후기 감사합니다.', fingerprint(review), 'wrong'); await assert.rejects(service.publish('9999', 'wrong')); assert.equal(count(), 0);
});
test('concurrent clicks with separate intents still post only once', async t => {
  const { service, count } = await setup(t); service.prepare(review.id, '후기 감사합니다.', fingerprint(review), 'one'); service.prepare(review.id, '후기 감사합니다.', fingerprint(review), 'two');
  const results = await Promise.allSettled([service.publish(review.id, 'one'), service.publish(review.id, 'two')]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(count(), 1);
});
test('uncertain registration is persisted and never retried automatically, including after restart', async t => {
  const { service, store, count } = await setup(t, () => { throw new Error('network dropped after click'); }); service.prepare(review.id, '후기 감사합니다.', fingerprint(review), 'one');
  await assert.rejects(service.publish(review.id, 'one'), e => e.code === 'RESULT_UNCERTAIN');
  const reloaded = new Store(store.directory); await reloaded.init(); assert.equal(Object.values(reloaded.data.submissions)[0].state, 'uncertain');
  service.prepare(review.id, '후기 감사합니다.', fingerprint(review), 'two'); await assert.rejects(service.publish(review.id, 'two'), e => e.code === 'DUPLICATE_ATTEMPT'); assert.equal(count(), 1);
});
test('changed review or store fails before publishing', async t => {
  const { service, store, count } = await setup(t); service.prepare(review.id, '후기 감사합니다.', fingerprint(review), 'one'); await store.update(s => { s.reviews[0].content = '수정된 리뷰'; });
  await assert.rejects(service.publish(review.id, 'one'), e => e.code === 'REVIEW_CHANGED'); assert.equal(count(), 0);
  assert.throws(() => assertSameReview(review, { ...review, store: '다른 스토어' }), e => e.code === 'REVIEW_CHANGED');
});
test('reply validation rejects empty, short, and overly long messages', () => { for (const text of ['', '   ', '짧아', 'a'.repeat(1001), null]) assert.throws(() => validateReply(text), AppError); assert.equal(validateReply('  후기 감사합니다.  '), '후기 감사합니다.'); });

test('a saved reply is reconciled after read-back fails without a second publish', async t => {
  const { service, store, count } = await setup(t, () => { throw new Error('Success notice blocked read-back'); });
  const text = '소중한 후기 감사합니다. 달콤한 하루 보내세요!';
  await store.update(s => { s.drafts[review.id] = { text }; });
  service.connector.detail = async () => ({ ...review, hasReply: true, reply: text });
  service.prepare(review.id, text, fingerprint(review), 'confirmed-click');
  const result = await service.publish(review.id, 'confirmed-click');
  assert.equal(result.reconciled, true); assert.equal(result.review.hasReply, true); assert.equal(result.review.reply, text);
  assert.equal(count(), 1); assert.equal(store.data.drafts[review.id], undefined); assert.equal(Object.values(store.data.submissions)[0].state, 'sent');
  assert.throws(() => service.prepare(review.id, text, fingerprint(review), 'second-click'), e => e.code === 'ALREADY_REPLIED');
});

test('manual verification cleans recovered drafts and attempts, including after restart', async t => {
  const { service, store, count } = await setup(t, () => { throw new Error('Read-back unavailable'); });
  const text = '직접 작성한 답글입니다. 감사합니다.';
  await store.update(s => { s.drafts[review.id] = { text }; });
  service.prepare(review.id, text, fingerprint(review), 'confirmed-click');
  await assert.rejects(service.publish(review.id, 'confirmed-click'), e => e.code === 'RESULT_UNCERTAIN');
  service.connector.detail = async () => ({ ...review, hasReply: true, reply: text });
  await service.detail(review.id);
  const saved = new Store(store.directory); await saved.init();
  assert.equal(saved.review(review.id).hasReply, true); assert.equal(saved.data.drafts[review.id], undefined);
  assert.equal(Object.values(saved.data.submissions)[0].state, 'sent'); assert.equal(count(), 1);
});

test('a different registered reply is reflected without claiming the requested text was posted', async t => {
  const { service, store, count } = await setup(t, () => { throw new Error('Read-back unavailable'); });
  const actual = '네이버에서 다른 담당자가 등록한 답글입니다.';
  service.connector.detail = async () => ({ ...review, hasReply: true, reply: actual });
  service.prepare(review.id, '내가 작성한 답글입니다.', fingerprint(review), 'confirmed-click');
  await assert.rejects(service.publish(review.id, 'confirmed-click'), e => e.code === 'REPLY_MISMATCH');
  assert.equal(store.review(review.id).reply, actual); assert.equal(store.review(review.id).hasReply, true); assert.equal(count(), 1);
});
test('drafts survive restart and AI input redacts common contact details', async t => { const { store } = await setup(t); await store.update(s => { s.drafts[review.id] = { text: '작성하던 초안' }; }); const again = new Store(store.directory); await again.init(); assert.equal(again.data.drafts[review.id].text, '작성하던 초안'); assert.equal(redact('test@example.com 010-1234-5678'), '[이메일] [전화번호]'); });
