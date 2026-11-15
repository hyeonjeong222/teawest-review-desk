import { NaverConnector } from '../src/naver.js';
import { Store } from '../src/core.js';
import { readReviewDetail } from '../src/naver-dom.js';
import path from 'node:path';
const store = new Store(path.resolve('.local')); await store.init();
const connector = new NaverConnector(store.directory);
let frame;
try {
  const target = store.data.reviews.find(r => !r.hasReply);
  ({ frame } = await connector.locate(target));
  const field = frame.locator('textarea[placeholder^="반복적인 답글"]');
  await field.fill('연동 확인을 위한 임시 초안입니다. 등록하지 않습니다.');
  const state = await frame.evaluate(readReviewDetail);
  console.log(JSON.stringify({ id: state.id, filled: state.reply === '연동 확인을 위한 임시 초안입니다. 등록하지 않습니다.', hasReply: state.hasReply, published: false }));
  await field.fill(''); await connector.closeDetails(frame);
} finally { await connector.browser?.close(); }
