import test from 'node:test';
import assert from 'node:assert/strict';
import {AblyConnector} from '../src/ably.js';
const raw=sno=>({sno,goods:{sno:1,name:'상품'},contents:'후기',images:[],satisfaction:true,status:1,created_at:'2026-01-01T00:00:00'});
function fixture(){
  const connector=new AblyConnector('unused'),calls=[];let rows=Array.from({length:90},(_,i)=>raw(i+1));
  connector.workspace=async()=>({store:'shop',page:{}});connector.storeName=async()=> 'shop';
  connector.fetchPage=async(_,index)=>{calls.push(index);return {reviews:rows.slice((index-1)*30,index*30),total_count:rows.length};};
  return {connector,calls,setRows:value=>{rows=value;},rows:()=>rows};
}
const checkpoint=result=>({checkpoint:result.checkpoint,sourceTotal:result.sourceTotal,knownIds:new Set(result.reviews.map(r=>r.id))});
test('Ably first scan establishes durable head checkpoint; unchanged refresh reads only head plus validation',async()=>{
  const f=fixture(),first=await f.connector.syncChanges('1y',{full:true});assert.deepEqual(f.calls,[1,2,3,1]);assert.equal(first.patchOnly,false);
  f.calls.length=0;const repeat=await f.connector.syncChanges('1y',JSON.parse(JSON.stringify({...checkpoint(first),knownIds:undefined})));
  // known IDs must be supplied by the persistent archive; missing IDs force a complete scan.
  assert.equal(repeat.patchOnly,false);
  f.calls.length=0;const next=await f.connector.syncChanges('1m',checkpoint(first));assert.deepEqual(f.calls,[1,1]);assert.equal(next.patchOnly,true);assert.equal(next.reviews.length,30);
});
test('Ably captures new reviews and old modified reviews moved above the checkpoint across page boundaries',async()=>{
  const f=fixture(),first=await f.connector.syncChanges('1y',{full:true});
  const changed={...raw(90),contents:'외부에서 수정된 후기'};f.setRows([raw(91),changed,...f.rows().filter(r=>r.sno!==90)]);f.calls.length=0;
  const next=await f.connector.syncChanges('1y',checkpoint(first));assert.deepEqual(f.calls,[1,2,1]);assert.equal(next.patchOnly,true);
  assert.equal(next.reviews.find(r=>r.id==='ably-90').content,changed.contents);assert.ok(next.reviews.some(r=>r.id==='ably-91'));
});
test('Ably deletions, balanced add/delete and replaced checkpoints fall back to all pages',async()=>{
  for(const mode of ['deleted','balanced','anchors']){
    const f=fixture(),first=await f.connector.syncChanges('1y',{full:true});
    if(mode==='deleted')f.setRows(f.rows().filter(r=>r.sno!==85));
    if(mode==='balanced')f.setRows([raw(91),...f.rows().filter(r=>r.sno!==85)]);
    if(mode==='anchors')f.setRows(f.rows().map(r=>r.sno>=26&&r.sno<=30?{...r,contents:'edited'}:r));
    f.calls.length=0;const next=await f.connector.syncChanges('1y',checkpoint(first));assert.equal(next.patchOnly,false,mode);assert.deepEqual(f.calls,[1,2,3,1]);
  }
});
test('Ably rejects a list that moves while pages are being read',async()=>{
  const f=fixture(),fetch=f.connector.fetchPage;let count=0;
  f.connector.fetchPage=async(...args)=>{if(++count===4)f.setRows([{...raw(1),contents:'changed during fetch'},...f.rows().slice(1)]);return fetch(...args);};
  await assert.rejects(f.connector.syncChanges('1y',{full:true}),e=>e.code==='ABLY_CHANGED');
});
