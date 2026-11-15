// Generates suggestions only. Does not save drafts or call prepare/publish.
const base = 'http://127.0.0.1:4317';
const session = await fetch(`${base}/api/session`).then(r => r.json());
if (!session.aiConfigured) throw new Error('Connect the OpenAI API key in the app first.');
const before = await fetch(`${base}/api/reviews`).then(r => r.json());
const review = before.reviews.find(r => !r.hasReply && r.content?.trim());
if (!review) throw new Error('No unanswered review available.');
const tones = ['간결하고 담백하게. 이모지는 사용하지 마세요.', '친근하고 밝게. 이모지는 한 개만 사용하세요.'];
const results = await Promise.allSettled(tones.map(async tone => {
  const response = await fetch(`${base}/api/reviews/${review.id}/suggest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Review-Token': session.csrf },
    body: JSON.stringify({ tone }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.code}: ${result.error}`);
  if (result.tone !== tone || !result.text) throw new Error('Suggestion or tone missing');
  return { tone: result.tone, text: result.text, characters: result.text.length };
}));
for (const result of results) console.log(JSON.stringify(result.status === 'fulfilled' ? { success: true, ...result.value } : { success: false, error: result.reason.message }));
const after = await fetch(`${base}/api/reviews`).then(r => r.json());
const latest = await fetch(`${base}/api/session`).then(r => r.json());
console.log(JSON.stringify({ defaultToneUnchanged: session.settings.tone === latest.settings.tone, draftsUnchanged: JSON.stringify(before.drafts) === JSON.stringify(after.drafts), reviewStillUnanswered: after.reviews.find(r => r.id === review.id)?.hasReply === false, publishRequested: false }));
if (results.some(r => r.status === 'rejected')) process.exitCode = 1;
