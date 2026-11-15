// Read-only recovery of previous submissions. Never calls prepare or publish.
import { NaverConnector, dismissReplySuccess } from '../src/naver.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base = 'http://127.0.0.1:4317';
const saved = JSON.parse(await readFile(new URL('../.local/state.json', import.meta.url), 'utf8'));
const ids = [...new Set(Object.values(saved.submissions).filter(s => ['attempting', 'uncertain'].includes(s.state)).map(s => s.reviewId))];
const connector = new NaverConnector(new URL('../.local', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
try {
  const { frame } = await connector.workspace();
  console.log(JSON.stringify({ completedNoticeDismissed: await dismissReplySuccess(frame) }));
  const session = await fetch(`${base}/api/session`).then(r => r.json());
  for (const id of ids) {
    const response = await fetch(`${base}/api/reviews/${id}/detail`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Review-Token': session.csrf }, body: '{}' });
    const result = await response.json();
    if (!response.ok) { console.log(JSON.stringify({ id, status: response.status, error: result.code })); continue; }
    const normalized = text => (text || '').replace(/\r\n?/g, '\n').trim();
    console.log(JSON.stringify({ id, hasReply: result.hasReply, matchesDraft: normalized(result.reply) === normalized(saved.drafts[id]?.text), matchesSubmission: Boolean(saved.submissions[`${id}:${createHash('sha256').update(result.reply.trim()).digest('hex')}`]), replyLength: result.reply.length }));
  }
} finally { await connector.browser?.close(); }
