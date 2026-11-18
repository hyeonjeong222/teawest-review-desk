import { randomBytes } from 'node:crypto';
import { InquiryInbox } from './inquiry-inbox.js';
import { AppError } from './core.js';

const unresolved = attempt => ['attempting', 'uncertain'].includes(attempt?.state);
const uncertain = () => new AppError('완료 처리 결과를 아직 확인하지 못했습니다. 내용 새로고침으로 확인해 주세요. 자동으로 다시 처리하지 않습니다.', 409, 'INQUIRY_COMPLETION_UNCERTAIN');

export class AblyInquiryInbox extends InquiryInbox {
  constructor(directory, adapter, queue) { super(directory, adapter, queue, { filename: 'ably-inquiries.json' }); this.completionIntents = new Map(); }
  async init() { await super.init(); this.data.completions ||= {}; }
  publicRecord(record) {
    const r = super.publicRecord(record), attempt = this.data.completions?.[r.id];
    return { ...r, completionAttempt: attempt ? { state: attempt.state, startedAt: attempt.startedAt } : null };
  }
  async read(id) {
    const fresh = await super.read(id);
    if (unresolved(this.data.completions[id]) && fresh.meta.roomStatus === 3) {
      await this.update(s => { s.completions[id].state = 'completed'; s.completions[id].confirmedAt = new Date().toISOString(); });
    }
    return fresh;
  }
  assertCanSend(id, record) { if (unresolved(this.data.completions[id])) throw uncertain(); super.assertCanSend(id, record); }
  assertCanComplete(id, record) {
    if (unresolved(this.data.completions[id])) throw uncertain();
    if (unresolved(this.data.attempts[id])) throw new AppError('이전 답변 등록 결과를 먼저 확인해 주세요.', 409, 'INQUIRY_UNCERTAIN');
    if (!record.detailed || !record.canComplete || typeof this.adapter.complete !== 'function') throw new AppError('현재 완료 처리할 수 없는 문의입니다. 내용을 새로고침해 주세요.', 409, 'INQUIRY_NOT_COMPLETABLE');
  }
  prepareComplete(id, expectedFingerprint) {
    return this.queue.run(async () => {
      const fresh = await this.read(id); this.assertCanComplete(id, fresh);
      const record = this.publicRecord(fresh);
      if (record.fingerprint !== expectedFingerprint) throw new AppError('문의 내용이나 상태가 변경되었습니다. 다시 확인해 주세요.', 409, 'INQUIRY_CHANGED');
      for (const [token, intent] of this.completionIntents) if (intent.expires < Date.now()) this.completionIntents.delete(token);
      const token = randomBytes(32).toString('hex');
      this.completionIntents.set(token, { id, fingerprint: record.fingerprint, expires: Date.now() + 300000 });
      return { token, inquiry: record };
    });
  }
  complete(id, token) {
    const intent = this.completionIntents.get(token); this.completionIntents.delete(token);
    if (!intent || intent.id !== id || intent.expires < Date.now()) return Promise.reject(new AppError('완료 처리 확인 시간이 만료되었습니다. 다시 확인해 주세요.', 409, 'INQUIRY_INTENT_EXPIRED'));
    return this.queue.run(async () => {
      const fresh = await this.read(id); this.assertCanComplete(id, fresh);
      if (this.publicRecord(fresh).fingerprint !== intent.fingerprint) throw new AppError('확인 중 새 대화가 도착했거나 문의 상태가 변경되었습니다. 다시 확인해 주세요.', 409, 'INQUIRY_CHANGED');
      let attempted = false;
      try {
        await this.adapter.complete(fresh, async () => {
          await this.update(s => { s.completions[id] = { state: 'attempting', startedAt: new Date().toISOString() }; }); attempted = true;
        });
        await this.read(id);
      } catch (error) {
        if (!attempted) throw error;
        await this.read(id).catch(() => {});
      }
      if (this.data.completions[id]?.state === 'completed') return { completed: true, inquiry: this.publicRecord(this.record(id)) };
      await this.update(s => { s.completions[id].state = 'uncertain'; }); throw uncertain();
    });
  }
}
