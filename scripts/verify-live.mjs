import { NaverConnector } from '../src/naver.js';
import { Store } from '../src/core.js';
const store = new Store(new URL('../.local', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
await store.init();
const connector = new NaverConnector(store.directory);
try {
  const target = store.data.reviews.find(r => r.hasReply);
  const detail = await connector.detail(target);
  console.log(JSON.stringify({ id: detail.id, hasReply: detail.hasReply, replyMatches: detail.reply?.includes('티웨스트입니다'), option: detail.option }));
  await store.update(s => Object.assign(s.reviews.find(r => r.id === detail.id), { reply: detail.reply, option: detail.option }));
} finally { await connector.browser?.close(); }
