import { AppError } from './core.js';

// Send only the context needed for a reply, without account metadata, IDs or attachment URLs.
export function inquiryAIInput(inquiry) {
  const identifiers = [inquiry.author, ...(String(inquiry.orderNo || '').split(/[,\s]+/))].filter(value => typeof value === 'string' && value.length >= 2 && !['고객', '구매자'].includes(value));
  const clean = value => {
    let result = String(value ?? '').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일]')
      .replace(/\b(?:\+?82[ -]?10|01[016789])[ -]?\d{3,4}[ -]?\d{4}\b/g, '[전화번호]')
      .replace(/((?:상품)?주문\s*(?:번호)?\s*[:：#]?\s*)\d[\d -]{5,}\d/g, '$1[주문번호]')
      .replace(/\b\d{8,}\b/g, '[식별번호]');
    for (const identifier of identifiers) result = result.split(identifier).join('[고객정보]');
    return result;
  };
  const input = { platform: inquiry.platform, category: inquiry.category, subject: clean(inquiry.title), product: clean(inquiry.product), option: clean(inquiry.option), question: clean(inquiry.content), status: inquiry.status, hasOrder: Boolean(inquiry.orderNo),
    conversation: (inquiry.messages || []).map(m => ({ role: ['customer', 'seller', 'system'].includes(m.role) ? m.role : 'system', text: clean(m.text), hasImage: Boolean(m.image) })),
    historyNote: clean(inquiry.historyNote), replyLengthLimit: inquiry.replyLimit || 1000 };
  if (JSON.stringify(input).length > 80000) throw new AppError('대화가 길어 GPT 초안을 만들 수 없습니다. 문의 내용을 확인해 직접 답변해 주세요.', 422, 'INQUIRY_AI_CONTEXT_LIMIT');
  return input;
}
