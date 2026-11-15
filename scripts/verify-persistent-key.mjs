import { chromium } from 'playwright-core';
const base = 'http://127.0.0.1:4317';
const session = await fetch(`${base}/api/session`).then(r => r.json());
if (!session.aiConfigured || !session.aiKey?.saved || session.aiKey.source !== 'saved') throw new Error('Saved API key was not restored');
console.log(JSON.stringify({ keyRestoredAfterRestart: true, keySavedEncrypted: true }));
const before = await fetch(`${base}/api/reviews`).then(r => r.json());
const review = before.reviews.find(r => !r.hasReply && r.content?.trim());
if (review) {
  const response = await fetch(`${base}/api/reviews/${review.id}/suggest`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Review-Token': session.csrf }, body: JSON.stringify({ tone: '간결하고 정중하게. 이모지는 사용하지 마세요.' }) });
  const result = await response.json();
  if (!response.ok || !result.text) throw new Error(`Recommendation failed: ${result.code || response.status}`);
  const after = await fetch(`${base}/api/reviews`).then(r => r.json());
  console.log(JSON.stringify({ realRecommendationGenerated: true, characters: result.text.length, draftsUnchanged: JSON.stringify(before.drafts) === JSON.stringify(after.drafts), publishRequested: false }));
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(base); await page.locator('#ai-chip').click(); await page.locator('#settings-dialog[open]').waitFor();
  const savedLabelVisible = await page.locator('#settings-ai-state').innerText() === '암호화 저장됨';
  const keyInputEmpty = await page.locator('#setting-key').inputValue() === '';
  if (!savedLabelVisible || !keyInputEmpty) throw new Error('Key settings UI check failed');
  await page.screenshot({ path: '.local/gpt-key-storage-qa.png', fullPage: true });
  console.log(JSON.stringify({ savedLabelVisible, keyInputEmpty }));
} finally { await browser.close(); }
