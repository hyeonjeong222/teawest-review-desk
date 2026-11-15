import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createApp} from '../src/server.js';
import {fingerprint, ReviewService} from '../src/core.js';
import {deliveryPlatforms} from '../public/platforms.js';
import {normalizeBaeminReview} from '../src/baemin.js';
import {normalizeEatsReview} from '../src/eats.js';
import {cleanupTestDirectory} from './cleanup.js';

test('delivery channels isolate shops, drafts, settings and confirmed publishing across the HTTP boundary',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'review-http-test-')),sent=[],suggestions=[];
 const originals=Object.fromEntries(Object.keys(deliveryPlatforms).map((p,i)=>[p,{id:`${p}-${i+1}-123`,sourceId:'123',platform:p,storeId:String(i+1),store:`${i+1} · ${deliveryPlatforms[p].brand}`,storeName:deliveryPlatforms[p].brand,productId:String(i+1),product:'테스트 메뉴',content:'맛있어요',rating:5,hasReply:false,replyAllowed:true,date:'2026.11.15',author:'고객'}]));
 const deliveryConnectors=Object.fromEntries(Object.entries(originals).map(([p,row])=>[p,{status:async()=>({connected:true,store:row.store}),sync:async period=>({reviews:[{...row}],total:1,store:row.store,period}),detail:async()=>({...row}),publish:async(r,text,before)=>{assert.equal(r.platform,p);await before();sent.push({p,text});row.hasReply=true;row.reply=text;return {reply:text};}}]));
 const disconnected={status:async()=>({connected:false})};
 const app=await createApp({directory,connector:disconnected,coupangConnector:disconnected,ablyConnector:disconnected,deliveryConnectors,ai:{configured:true,generate:async(r,s)=>{suggestions.push({p:r.platform,...s});return `${s.brand}를 찾아주셔서 감사합니다. 다음에도 맛있게 준비하겠습니다.`;}},keyVault:{init:async()=>{},publicState:()=>({saved:true})},port:14551,maintenanceInterval:0});
 app.server.listen(14551,'127.0.0.1');await once(app.server,'listening');
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await cleanupTestDirectory(directory);});
 const base='http://127.0.0.1:14551',post=async(route,data,token=app.csrf)=>fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Review-Token':token},body:JSON.stringify(data)});
 for(const p of Object.keys(deliveryPlatforms))assert.equal((await post('/api/sync',{platform:p,period:'1m'})).status,200);
 assert.equal(app.store.data.reviews.length,4);
 deliveryConnectors['baemin-teawest'].progress={phase:'syncing',period:'1y',window:1,windows:2,rows:120,total:800};
 const progress=await fetch(base+'/api/reviews').then(r=>r.json());
 assert.deepEqual(progress.syncProgress['baemin-teawest'],deliveryConnectors['baemin-teawest'].progress);
 const a=originals['baemin-teawest'],b=originals['baemin-besti'],e=originals['coupangeats-besti'];
 await post(`/api/reviews/${a.id}/draft`,{text:'티웨스트의 초안입니다.'});await post(`/api/reviews/${b.id}/draft`,{text:'베스티의 초안입니다.'});
 await post('/api/sync',{platform:b.platform});assert.equal(app.store.data.drafts[a.id].text,'티웨스트의 초안입니다.');
 await post('/api/settings',{platform:b.platform,brand:'베스티',tone:'간결하고 담백하게',guidance:'베스티 전용 지침'});
 assert.equal(app.store.data.settings.brand,'티웨스트');
 await post(`/api/reviews/${b.id}/suggest`,{});await post(`/api/reviews/${a.id}/suggest`,{});
 assert.equal(suggestions[0].brand,'베스티');assert.equal(suggestions[0].guidance,'베스티 전용 지침');assert.equal(suggestions[1].brand,'티웨스트');assert.equal(suggestions[1].guidance,'');assert.equal(sent.length,0);
 assert.equal((await post(`/api/reviews/${e.id}/draft`,{text:'가'.repeat(301)})).status,400);
 assert.equal((await post(`/api/reviews/${e.id}/prepare`,{text:'가'.repeat(301),fingerprint:fingerprint(e)})).status,400);
 assert.equal((await post(`/api/reviews/${b.id}/prepare`,{text:'후기 감사합니다.',fingerprint:fingerprint(a)})).status,409);
 assert.equal((await post(`/api/reviews/${b.id}/publish`,{token:'missing'})).status,409);
 const prepared=await (await post(`/api/reviews/${b.id}/prepare`,{text:'베스티를 찾아주셔서 감사합니다.',fingerprint:fingerprint(b)})).json();
 assert.equal(sent.length,0);assert.equal((await post(`/api/reviews/${a.id}/publish`,{token:prepared.token})).status,409);
 assert.equal((await post(`/api/reviews/${b.id}/publish`,{token:prepared.token},'bad')).status,403);
 assert.equal((await post(`/api/reviews/${b.id}/publish`,{token:prepared.token})).status,200);
 assert.deepEqual(sent,[{p:b.platform,text:'베스티를 찾아주셔서 감사합니다.'}]);assert.equal(app.store.data.drafts[b.id],undefined);assert.equal(app.store.data.drafts[a.id].text,'티웨스트의 초안입니다.');
 assert.equal((await post(`/api/reviews/${b.id}/publish`,{token:prepared.token})).status,409);
 // A different wording must not bypass an unresolved submission for the same review.
 await app.store.update(s=>{s.submissions.pending={reviewId:a.id,state:'uncertain'};});
 const retry=await (await post(`/api/reviews/${a.id}/prepare`,{text:'다르게 쓴 답글입니다.',fingerprint:fingerprint(a)})).json();
 assert.equal((await post(`/api/reviews/${a.id}/publish`,{token:retry.token})).status,409);assert.equal(sent.length,1);
 await assert.rejects(app.sources[a.platform].service.suggest(b.id),e=>e.code==='STORE_CHANGED');
});

test('delivery normalizers retain reply state and reject a different shop without retaining order/account identifiers',()=>{
 const shop={id:'11',name:'티웨스트'},p='baemin-teawest';
 const raw={id:2026111203056515,shopNumber:11,rating:5,contents:'좋아요',comments:[{displayType:'CEO',contents:'감사합니다.'}],menus:[{name:'커피'}],images:[],writableComment:true,createdAt:'2026-11-12T10:00:00',displayType:'ALL',memberNo:999};
 const row=normalizeBaeminReview(raw,p,shop);assert.equal(row.reply,'감사합니다.');assert.equal(row.hasReply,true);assert.equal(row.memberNo,undefined);assert.throws(()=>normalizeBaeminReview({...raw,shopNumber:12},p,shop));
 const eats={orderReviewId:123,storeId:11,comment:'좋아요',rating:5,orderInfo:[{dishName:'커피'}],replies:[{content:'감사합니다.'}],images:[],createdAt:'2020-01-01T10:00:00',orderId:999,abbrOrderId:'ABC',statusType:'EXPOSE'};
 const e=normalizeEatsReview(eats,'coupangeats-teawest',shop);assert.equal(e.reply,'감사합니다.');assert.equal(e.replyAllowed,false);assert.equal(e.orderId,undefined);assert.equal(e.abbrOrderId,undefined);assert.throws(()=>normalizeEatsReview({...eats,storeId:12},'coupangeats-teawest',shop));
});
