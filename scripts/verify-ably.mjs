import { AblyConnector } from '../src/ably.js';
const connector = new AblyConnector('.local');
try {
 const result = await connector.sync(process.argv[2] || '6m');
 console.log(JSON.stringify({total:result.total,sourceTotal:result.sourceTotal,store:result.store,from:result.from,to:result.to,photos:result.reviews.filter(r=>r.media.length).length,satisfied:result.reviews.filter(r=>r.satisfaction).length,unsatisfied:result.reviews.filter(r=>!r.satisfaction).length,onlyReadOnly:result.reviews.every(r=>r.readOnly&&r.rating===null)},null,2));
} finally {await connector.host.browser?.close();}
