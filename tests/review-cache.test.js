import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store,ReviewService,fingerprint} from '../src/core.js';
import {reviewRange,isoDay,missingRanges,mergeRanges,planReviewRefresh,selectCachedPeriod} from '../src/review-cache.js';
import {cleanupTestDirectory} from './cleanup.js';

const now=new Date('2026-11-16T03:00:00Z'),year=reviewRange('1y',now);
const row=(id,date,extra={})=>({id,platform:'naver',store:'shop',date,productId:'1',product:'상품',content:'후기',rating:5,hasReply:false,...extra});
async function fixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'review-desk-test-'));t.after(()=>cleanupTestDirectory(dir));
  const store=new Store(dir);await store.init();let rows=[row('old','2026-01-01'),row('recent','2026-11-10')];const calls=[];
  const connector={status:async()=>({connected:true,store:'shop'}),syncRange:async range=>{
    calls.push(range);const reviews=rows.filter(r=>isoDay(r.date)>=range.from&&isoDay(r.date)<=range.to).map(r=>({...r}));
    return {reviews,total:reviews.length,store:'shop',...range};
  }};
  return {store,connector,calls,setRows:value=>{rows=value;},service:new ReviewService(store,connector,{})};
}

test('calendar coverage handles Korean midnight, leap months, and exact missing gaps',()=>{
  assert.deepEqual(reviewRange('1m',new Date('2024-03-30T15:00:00Z')),{from:'2024-03-01',to:'2024-03-31'});
  assert.equal(isoDay('2026.2.30'),null);
  assert.deepEqual(mergeRanges([{from:'2026-01-01',to:'2026-01-05'},{from:'2026-01-06',to:'2026-01-10'}]),[{from:'2026-01-01',to:'2026-01-10'}]);
  assert.deepEqual(missingRanges({from:'2026-01-01',to:'2026-01-10'},[{from:'2026-01-03',to:'2026-01-05'}]),[{from:'2026-01-01',to:'2026-01-02'},{from:'2026-01-06',to:'2026-01-10'}]);
});

test('first fetch persists archive; repeat only checks recent rows and preserves old reviews and drafts after restart',async t=>{
  const f=await fixture(t);await f.service.sync('1y',{now});assert.deepEqual(f.calls,[year]);
  await f.store.update(s=>{s.drafts.old={text:'보존할 초안'};});
  const restarted=new Store(f.store.directory);await restarted.init();
  f.setRows([row('old','2026-01-01'),row('recent','2026-11-10',{hasReply:true,reply:'바뀐 답글'}),row('new','2026-11-16')]);
  await new ReviewService(restarted,f.connector,{}).sync('1y',{now});
  assert.deepEqual(f.calls.at(-1),{from:'2026-10-17',to:'2026-11-16'});
  assert.equal(restarted.data.reviews.length,3);assert.equal(restarted.review('recent').reply,'바뀐 답글');
  assert.equal(restarted.data.drafts.old.text,'보존할 초안');assert.equal(restarted.data.syncs.naver.added,1);assert.equal(restarted.data.syncs.naver.replyChanged,1);
  assert.equal(restarted.data.syncs.naver.cacheUpdate,undefined);
  const count=f.calls.length;
  await restarted.update(s=>{assert.equal(selectCachedPeriod(s,'naver','1m',now),true);});
  assert.equal(restarted.data.reviews.length,2);assert.equal(restarted.data.reviewArchive.length,3);
  await restarted.update(s=>{assert.equal(selectCachedPeriod(s,'naver','1y',now),true);});
  assert.equal(restarted.data.reviews.length,3);assert.equal(f.calls.length,count);
});

test('backfill fetches missing history, full mode rechecks everything, and daily rollover has no cache false positive',async t=>{
  const f=await fixture(t);await f.service.sync('1m',{now});
  assert.equal(selectCachedPeriod(f.store.data,'naver','1y',now),false);
  await f.service.sync('1y',{now});assert.deepEqual(f.calls.at(-1),year);assert.equal(f.store.data.reviews.length,2);
  await f.service.sync('1y',{now,full:true});assert.deepEqual(f.calls.at(-1),year);
  const tomorrow=new Date('2026-11-17T03:00:00Z');assert.equal(selectCachedPeriod(f.store.data,'naver','1y',tomorrow),false);
  assert.equal(planReviewRefresh(f.store.data.reviewCache.naver,'naver',reviewRange('1y',tomorrow),{now:tomorrow}).ranges.at(-1).to,'2026-11-17');
});

test('old reply edits rotate through bounded audit windows and recent reply deletion clears stale text',async t=>{
  const f=await fixture(t);f.setRows([row('old','2025-11-20'),row('recent','2026-11-10',{hasReply:true,reply:'old text'})]);
  await f.service.sync('1y',{now});f.calls.length=0;
  f.setRows([row('old','2025-11-20',{hasReply:true,reply:'edited externally'}),row('recent','2026-11-10')]);
  const later=new Date(now.getTime()+600001);await f.service.sync('1y',{now:later});
  assert.deepEqual(f.calls,[{from:'2025-11-17',to:'2025-12-14'},{from:'2026-10-17',to:'2026-11-16'}]);
  assert.equal(f.store.review('old').reply,'edited externally');assert.equal(f.store.review('recent').reply,null);
  assert.equal(f.store.data.reviewCache.naver.auditCursor,'2025-12-15');
  f.calls.length=0;await f.service.sync('1y',{now:later});assert.equal(f.calls.length,1);
});

test('partial reads and failed detail hydration leave both archive and checkpoint untouched',async t=>{
  const f=await fixture(t);await f.service.sync('1y',{now});const before=JSON.stringify(f.store.data);
  const original=f.connector.syncRange;
  f.connector.syncRange=async range=>({...await original(range),total:999});
  await assert.rejects(f.service.sync('1y',{now}),e=>e.code==='INCOMPLETE_SYNC');assert.equal(JSON.stringify(f.store.data),before);
  f.connector.syncRange=async range=>({...await original(range),reviews:[row('wrong','2020-01-01')],total:1});
  await assert.rejects(f.service.sync('1y',{now}),e=>e.code==='INCOMPLETE_SYNC');assert.equal(JSON.stringify(f.store.data),before);
  f.connector.syncRange=original;f.connector.readReplies=async()=>{throw new Error('detail unavailable');};
  await assert.rejects(f.service.sync('1y',{now}),/detail unavailable/);assert.equal(JSON.stringify(f.store.data),before);
});

test('confirmed source deletions leave an archive tombstone and never erase a draft',async t=>{
  const f=await fixture(t);await f.service.sync('1y',{now});await f.store.update(s=>{s.drafts.recent={text:'내 초안'};});
  f.setRows([row('old','2026-01-01')]);await f.service.sync('1y',{now});
  assert.equal(f.store.data.reviews.length,1);assert.ok(f.store.data.reviewArchive.find(r=>r.id==='recent').sourceRemovedAt);assert.equal(f.store.data.drafts.recent.text,'내 초안');
  await f.store.update(s=>selectCachedPeriod(s,'naver','1y',now));assert.equal(f.store.data.reviews.length,1);
});

test('account switches force manual backfill and never mix cached shops; automatic switches are rejected',async t=>{
  const f=await fixture(t);await f.service.sync('1y',{now});f.connector.status=async()=>({connected:true,store:'other'});
  await assert.rejects(f.service.sync('1y',{now,automatic:true}),e=>e.code==='STORE_CHANGED');
  f.connector.syncRange=async range=>({reviews:[row('other-id','2026-11-16',{store:'other'})],total:1,store:'other',...range});
  await f.service.sync('1y',{now});assert.equal(f.store.data.reviews.length,1);assert.equal(f.store.data.reviews[0].store,'other');assert.equal(f.store.data.reviewArchive.length,3);
});

test('published replies persist in archive and a period changed during fetch is retained',async t=>{
  const f=await fixture(t);await f.service.sync('1y',{now});
  f.connector.publish=async(r,text,beforeClick)=>{await beforeClick();return {reply:text};};
  const intent=f.service.prepare('old','직접 확인한 답글입니다.',fingerprint(f.store.review('old')),'confirmed');await f.service.publish('old',intent.token);
  await f.store.update(s=>selectCachedPeriod(s,'naver','1m',now));await f.store.update(s=>selectCachedPeriod(s,'naver','1y',now));assert.equal(f.store.review('old').reply,'직접 확인한 답글입니다.');
  const original=f.connector.syncRange;let release,entered;const ready=new Promise(r=>{entered=r;});
  f.connector.syncRange=async range=>{entered();await new Promise(r=>{release=r;});return original(range);};
  const pending=f.service.sync('1y',{now});await ready;
  await f.store.update(s=>{s.reviewPeriod='1m';selectCachedPeriod(s,'naver','1m',now);});release();await pending;
  assert.equal(f.store.data.syncs.naver.period,'1m');assert.equal(f.store.data.reviews.length,1);assert.equal(f.store.data.reviewArchive.length,2);
});

test('detail or a human-confirmed reply finishing after a period switch updates the archived review',async t=>{
  const f=await fixture(t);await f.service.sync('1y',{now});let release,entered;
  let ready=new Promise(r=>{entered=r;});
  f.connector.detail=async expected=>{entered();await new Promise(r=>{release=r;});return {...expected,reply:null};};
  const detail=f.service.detail('old');await ready;await f.store.update(s=>selectCachedPeriod(s,'naver','1m',now));release();await detail;
  assert.equal(f.store.data.reviews.length,1);assert.ok(f.store.review('old').detailCheckedAt);
  await f.store.update(s=>selectCachedPeriod(s,'naver','1y',now));
  ready=new Promise(r=>{entered=r;});f.connector.publish=async(r,text,beforeClick)=>{await beforeClick();entered();await new Promise(r=>{release=r;});return {reply:text};};
  f.service.prepare('old','사람이 승인한 답글입니다.',fingerprint(f.store.review('old')),'human');
  const publish=f.service.publish('old','human');await ready;await f.store.update(s=>selectCachedPeriod(s,'naver','1m',now));release();await publish;
  const restored=new Store(f.store.directory);await restored.init();await restored.update(s=>selectCachedPeriod(s,'naver','1y',now));
  assert.equal(restored.review('old').reply,'사람이 승인한 답글입니다.');
});

test('a changed connector date format revalidates coverage instead of trusting older archive dates',async t=>{
  const f=await fixture(t);await f.service.sync('1y',{now});f.calls.length=0;f.connector.cacheVersion=1;
  await f.service.sync('1m',{now});assert.deepEqual(f.calls,[reviewRange('1m',now)]);
  assert.equal(selectCachedPeriod(f.store.data,'naver','1y',now),false);
  assert.equal(f.store.data.reviewCache.naver.connectorVersion,1);assert.equal(f.store.data.reviewArchive.length,2);
  await f.service.sync('1y',{now});assert.equal(selectCachedPeriod(f.store.data,'naver','1y',now),true);
});
