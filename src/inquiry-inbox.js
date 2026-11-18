import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { AppError, SerialQueue, validateReply } from './core.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = r => hash(r.storeId ? [r.storeId, r.store, r.category, r.sourceId] : [r.store, r.category, r.sourceId]);
const fingerprint = r => hash([r.store, r.category, r.sourceId, r.title, r.content, r.product, r.option, r.author, r.orderNo, r.status, r.canReply, r.canComplete, r.replyMode, r.replyLimit, r.confirmationText, r.historyNote, r.messages, r.meta]);
const limit = r => r.replyLimit || (r.category === 'center' ? 3000 : 1000);
const normalizedText = text => text.replace(/\r\n?/g, '\n').trim();
const unresolved = attempt => ['attempting', 'uncertain'].includes(attempt?.state);

// Inquiry storage is independent of reviews, including drafts and durable send attempts.
export class InquiryInbox {
  constructor(directory, adapter, queue = new SerialQueue(), { filename = 'inquiries.json' } = {}) {
    this.file = path.join(directory, filename); this.queue = queue; this.writes = new SerialQueue(); this.adapter = adapter;
    this.data = { version: 1, records: {}, drafts: {}, attempts: {} }; this.intents = new Map();
    this.generating = new Set();
  }
  async init() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.records || !saved.drafts || !saved.attempts) throw new Error('Invalid inquiry storage');
      this.data = saved;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  update(fn) {
    return this.writes.run(async () => {
      const next = structuredClone(this.data); const result = fn(next);
      await writeFile(this.file + '.tmp', JSON.stringify(next), 'utf8'); await rename(this.file + '.tmp', this.file);
      this.data = next; return result;
    });
  }
  record(id) { const r = this.data.records[id]; if (!r) throw new AppError('문의 목록을 먼저 조회해 주세요.', 404, 'INQUIRY_NOT_FOUND'); return r; }
  publicRecord(record) {
    const { meta, ...r } = record, id = key(record), attempt = this.data.attempts[id];
    return { ...r, id, fingerprint: fingerprint(record), replyLimit: limit(record), draft: this.data.drafts[id]?.text || '', attempt: attempt ? { state: attempt.state, startedAt: attempt.startedAt } : null };
  }
  list(category, period) {
    return this.queue.run(async () => {
      const result = await this.adapter.list(category, period);
      await this.update(s => { for (const record of result.records) s.records[key(record)] = record; });
      return { ...result, records: result.records.map(r => this.publicRecord(r)) };
    });
  }
  async read(id) {
    const expected = this.record(id), fresh = await this.adapter.detail(expected);
    if (key(fresh) !== id) throw new AppError('스토어 또는 문의가 변경되었습니다.', 409, 'INQUIRY_CHANGED');
    await this.update(s => {
      s.records[id] = fresh;
      const attempt = s.attempts[id];
      if (unresolved(attempt) && fresh.messages.some(m => (attempt.messageId ? m.id === attempt.messageId : m.role === 'seller') && !attempt.beforeIds.includes(m.id) && normalizedText(m.text) === attempt.text)) {
        attempt.state = 'sent'; attempt.confirmedAt = new Date().toISOString();
        if (normalizedText(s.drafts[id]?.text || '') === attempt.text) delete s.drafts[id];
      }
    });
    return fresh;
  }
  detail(id) { return this.queue.run(async () => this.publicRecord(await this.read(id))); }
  async draft(id, text) {
    const record = this.record(id);
    if (typeof text !== 'string' || text.length > limit(record)) throw new AppError(`답변은 ${limit(record)}자 이하로 작성해 주세요.`);
    await this.update(s => { s.drafts[id] = { text, savedAt: new Date().toISOString() }; });
    return { saved: true };
  }
  assertCanSend(id, r) {
    if (unresolved(this.data.attempts[id])) throw new AppError('이전 답변의 등록 결과를 확인 중입니다. 내용을 새로고침해 확인해 주세요. 중복 등록은 차단됩니다.', 409, 'INQUIRY_UNCERTAIN');
    if (!r.detailed || !r.canReply) throw new AppError('이미 답변했거나 답변할 수 없는 문의입니다. 내용을 다시 확인해 주세요.', 409, 'INQUIRY_NOT_REPLYABLE');
  }
  async suggest(id, ai, settings, expectedFingerprint, tone) {
    if (tone !== undefined && (typeof tone !== 'string' || !tone.trim() || tone.trim().length > 200)) throw new AppError('추천 말투는 1~200자로 입력해 주세요.', 400, 'INVALID_TONE');
    if (!ai.configured) throw new AppError('설정에서 OpenAI API 키를 먼저 연결해 주세요.', 400, 'API_KEY_REQUIRED');
    if (this.generating.has(id)) throw new AppError('이 문의의 GPT 초안을 만들고 있습니다. 잠시 기다려 주세요.', 409, 'INQUIRY_AI_BUSY');
    this.generating.add(id);
    try {
      const snapshot = await this.queue.run(async () => {
        const fresh = await this.read(id); this.assertCanSend(id, fresh);
        if (fresh.replyMode === 'confirm') throw new AppError('확인완료 문의는 쿠팡의 지정 문구로 처리합니다.', 409, 'INQUIRY_CONFIRM_ONLY');
        if (fingerprint(fresh) !== expectedFingerprint) throw new AppError('문의 내용이 변경되었습니다. 새로고침 후 초안을 만들어 주세요.', 409, 'INQUIRY_CHANGED');
        return structuredClone(fresh);
      });
      const preferences = { ...settings, brand: snapshot.store || settings.brand, tone: tone === undefined ? settings.tone : tone.trim() };
      const text = validateReply(await ai.generateInquiry({ ...snapshot, replyLimit: limit(snapshot) }, preferences), limit(snapshot));
      // Do not hold the seller queue during the model request; discard results when the conversation changes.
      return await this.queue.run(async () => {
        const fresh = await this.read(id); this.assertCanSend(id, fresh);
        if (fingerprint(fresh) !== fingerprint(snapshot)) throw new AppError('초안을 만드는 동안 대화나 상태가 변경되었습니다. 새로고침 후 다시 만들어 주세요.', 409, 'INQUIRY_CHANGED');
        return { text, tone: preferences.tone, fingerprint: fingerprint(fresh) };
      });
    } finally { this.generating.delete(id); }
  }
  prepare(id, text, expectedFingerprint) {
    return this.queue.run(async () => {
      const fresh = await this.read(id); this.assertCanSend(id, fresh);
      if (typeof text !== 'string' || !text.trim() || text.length > limit(fresh)) throw new AppError(`답변은 1~${limit(fresh)}자로 작성해 주세요.`);
      if (fresh.replyMode === 'confirm' && text !== fresh.confirmationText) throw new AppError('확인완료 유형의 문의입니다. 확인완료 버튼을 사용해 주세요.', 409, 'INQUIRY_CONFIRM_ONLY');
      if (fingerprint(fresh) !== expectedFingerprint) throw new AppError('문의 내용이나 답변 상태가 변경되었습니다. 내용을 새로고침한 뒤 다시 확인해 주세요.', 409, 'INQUIRY_CHANGED');
      for (const [token, intent] of this.intents) if (intent.expires < Date.now()) this.intents.delete(token);
      const token = randomBytes(32).toString('hex'), cleaned = normalizedText(text);
      this.intents.set(token, { id, text: cleaned, fingerprint: fingerprint(fresh), expires: Date.now() + 300000 });
      return { token, text: cleaned, inquiry: this.publicRecord(fresh) };
    });
  }
  publish(id, token) {
    const intent = this.intents.get(token); this.intents.delete(token);
    if (!intent || intent.id !== id || intent.expires < Date.now()) return Promise.reject(new AppError('답변 확인 시간이 만료되었습니다. 다시 확인해 주세요.', 409, 'INQUIRY_INTENT_EXPIRED'));
    return this.queue.run(async () => {
      const fresh = await this.read(id); this.assertCanSend(id, fresh);
      if (fingerprint(fresh) !== intent.fingerprint) throw new AppError('확인 중 문의가 변경되었습니다. 내용을 새로고침한 뒤 다시 확인해 주세요.', 409, 'INQUIRY_CHANGED');
      let attempted = false;
      try {
        const receipt = await this.adapter.reply(fresh, intent.text, async () => {
          await this.update(s => { s.attempts[id] = { state: 'attempting', text: intent.text, beforeIds: fresh.messages.map(m => m.id), startedAt: new Date().toISOString() }; });
          attempted = true;
        });
        if (receipt?.messageId) await this.update(s => { s.attempts[id].messageId = String(receipt.messageId); });
        await this.read(id);
      } catch (error) {
        if (!attempted) throw error;
        // Even an HTTP error can occur after the seller accepted the answer. Read, never resend.
        await this.read(id).catch(() => {});
      }
      if (this.data.attempts[id]?.state === 'sent') return { sent: true, inquiry: this.publicRecord(this.record(id)) };
      await this.update(s => { s.attempts[id].state = 'uncertain'; });
      throw new AppError('답변을 요청했지만 등록 결과를 아직 확인하지 못했습니다. 내용을 새로고침해 확인해 주세요. 답변은 자동으로 재전송하지 않습니다.', 409, 'INQUIRY_UNCERTAIN');
    });
  }
}
