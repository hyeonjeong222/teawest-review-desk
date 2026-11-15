import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server.js';
import { Store, AppError } from '../src/core.js';
import { platforms } from '../public/platforms.js';
import { cleanupTestDirectory } from './cleanup.js';

test('shared period queries every shop including a full Baemin year, persists selection, and reports partial failures', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-http-test-')), calls = [];
  let fail = false;
  const connectors = Object.fromEntries(platforms.map(platform => [platform, {
    status: async () => ({connected:true,store:platform}),
    sync: async period => {
      calls.push({platform,period});
      if (fail && platform === 'coupangeats-besti') throw new AppError('조회 테스트 실패',502,'TEST_FAILURE');
      const count = period === '1m' ? 1 : period === '6m' ? 2 : 3;
      return {period,store:platform,total:count,reviews:Array.from({length:count},(_,i)=>({id:platform==='naver'?String(i):`${platform}-${i}`,platform,store:platform,productId:'1',product:'상품',content:'후기',rating:5,date:'2026.11.10',hasReply:false}))};
    },
  }]));
  const port=14681;
  const app=await createApp({directory,port,maintenanceInterval:0,connector:connectors.naver,coupangConnector:connectors.coupang,ablyConnector:connectors.ably,deliveryConnectors:connectors,keyVault:{init:async()=>{},publicState:()=>({saved:false})},ai:{configured:false}});
  app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await cleanupTestDirectory(directory);});
  const base=`http://127.0.0.1:${port}`, sync=period=>fetch(base+'/api/sync',{method:'POST',headers:{origin:base,'content-type':'application/json','x-review-token':app.csrf},body:JSON.stringify({platform:'all',period})});
  assert.equal((await sync('invalid')).status,400);assert.equal(calls.length,0);
  const month=await sync('1m').then(r=>r.json());assert.deepEqual(month.warnings,[]);assert.equal(month.reviewPeriod,'1m');
  for(const platform of platforms){assert.equal(month.syncs[platform].period,'1m');assert.equal(month.reviews.filter(r=>r.platform===platform).length,1);}
  fail=true;calls.length=0;
  const year=await sync('1y').then(r=>r.json());assert.equal(year.reviewPeriod,'1y');assert.equal(year.warnings.length,1);assert.equal(year.warnings[0].platform,'coupangeats-besti');
  for(const call of calls) assert.equal(call.period,'1y');
  assert.equal(year.syncs['baemin-teawest'].total,3);assert.equal(year.syncs['coupangeats-teawest'].total,3);assert.equal(year.syncs['coupangeats-besti'].period,'1m');
  const reloaded=new Store(directory);await reloaded.init();assert.equal(reloaded.data.reviewPeriod,'1y');
});
