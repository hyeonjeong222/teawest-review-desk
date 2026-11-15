import { AppError } from './core.js';

// A manually launched Chrome can stop rendering a tab when another store opens.
// Keep only the page being read active; never bring the browser over the user's app.
export async function withActiveReviewPage(page, operation) {
  const session = await page.context().newCDPSession(page);
  try {
    try { await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }); }
    catch { throw new AppError('연결 창의 리뷰 화면을 활성화하지 못했습니다. Chrome 또는 Edge를 업데이트하고 연결 창을 다시 열어 주세요.', 503, 'BROWSER_ACTIVITY'); }
    return await operation();
  } finally {
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    await session.detach().catch(() => {});
  }
}
