import test from 'node:test';
import assert from 'node:assert/strict';
import { BaeminConnector, baeminDateWindows } from '../src/baemin.js';
import { coupangDateRange } from '../src/coupang.js';

test('Baemin windows cover a complete year without gaps or overlaps, including month ends and leap days', () => {
  for(const today of ['2026-11-15','2024-02-29','2025-08-30','2026-01-31']) {
    const range=coupangDateRange('1y',new Date(today+'T03:00:00Z')), windows=baeminDateWindows(range.from,range.to);
    assert.equal(windows[0].from,range.from);assert.equal(windows.at(-1).to,range.to);
    let last=Date.parse(range.from)-86400000;
    for(const window of windows){const start=Date.parse(window.from),end=Date.parse(window.to);assert.equal(start,last+86400000);assert.ok(end>=start);assert.ok(end-start<184*86400000);last=end;}
  }
  assert.deepEqual(baeminDateWindows('2025-11-16','2026-11-15'),[{from:'2025-11-16',to:'2026-05-15'},{from:'2026-05-16',to:'2026-11-15'}]);
});
test('Baemin year combines complete windows and rejects incomplete, duplicate, or changed-store results', async () => {
  const connector=new BaeminConnector({},'baemin-teawest');let calls=[];
  connector.collect=async(period,target,range)=>{calls.push(range);return {store:'1 · 티웨스트',storeName:'티웨스트',total:1,reviews:[{id:range.from,date:range.from}]};};
  const result=await connector.sync('1y');assert.equal(result.period,'1y');assert.equal(result.total,calls.length);assert.ok(calls.length>=2);assert.equal(result.from,calls[0].from);assert.equal(result.to,calls.at(-1).to);
  connector.collect=async()=>({store:'1',total:1,reviews:[{id:'same'}]});await assert.rejects(connector.sync('1y'),e=>e.code==='INCOMPLETE_SYNC');
  connector.collect=async()=>({store:'1',total:2,reviews:[{id:Math.random()}]});await assert.rejects(connector.sync('1y'));
  let index=0;connector.collect=async()=>({store:String(++index),total:0,reviews:[]});await assert.rejects(connector.sync('1y'),e=>e.code==='STORE_CHANGED');
});
