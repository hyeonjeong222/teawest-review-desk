import test from 'node:test';
import assert from 'node:assert/strict';
import { BaeminConnector, baeminDateWindows, baeminDates, BaeminReadWatchdog, selectBaeminDates } from '../src/baemin.js';
import { coupangDateRange } from '../src/coupang.js';
import { chromium } from 'playwright-core';

test('Baemin accepts the abbreviated same-year period label and full cross-year filter label',()=>{
  assert.deepEqual(baeminDates('2026. 5. 17 ~ 11. 16'),['2026-05-17','2026-11-16']);
  assert.deepEqual(baeminDates('날짜 직접 선택\n2025. 11. 17 (월) ~ 2026. 5. 16 (토)'),['2025-11-17','2026-05-16']);
  assert.deepEqual(baeminDates('날짜 직접 선택'),[]);
});

test('Baemin missing dates and stalled pages fail promptly while growing pages can continue',()=>{
  let now=0; const missing=new BaeminReadWatchdog(()=>now);
  missing.check(null); now=15001;
  assert.throws(()=>missing.check(null),e=>e.code==='INCOMPLETE_SYNC');
  now=0; const reading=new BaeminReadWatchdog(()=>now), group={rows:new Map(),total:100,offsets:new Set([0])};
  reading.check(group); now=19000; group.rows.set('first',{}); reading.check(group);
  now=38000; group.rows.set('second',{}); reading.check(group);
  now=58001; assert.throws(()=>reading.check(group),e=>e.code==='INCOMPLETE_SYNC');
  now=0; const bounded=new BaeminReadWatchdog(()=>now); bounded.check(group);
  now=180001;group.rows.set('third',{});assert.throws(()=>bounded.check(group),e=>e.code==='INCOMPLETE_SYNC');
});

test('Baemin waits for calendar month commits and retries a collapsed range before submitting the filter',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent(`<input type="radio" aria-label="날짜 직접 선택">
    <div role="dialog" id="sheet"><h2>기간</h2><button id="selected">2026. 5. 17 ~ 2026. 11. 16</button><button id="applySheet">적용</button></div>
    <div role="dialog" id="calendar" hidden><button id="prev">이전 달</button><button id="next">다음 달</button><table role="grid"><caption></caption><tbody></tbody></table><button id="reset">초기화</button><button id="applyCalendar">적용</button></div>
    <script>
    let month=2026*12+10,dates=[],attempts=0; window.applied=[];
    const calendar=document.querySelector('#calendar'),sheet=document.querySelector('#sheet'),selected=document.querySelector('#selected');
    function render(){const year=Math.floor(month/12),m=month%12+1,table=calendar.querySelector('table');table.setAttribute('aria-label',year+'년 '+m+'월');table.querySelector('caption').textContent=year+'년 '+m+'월';table.querySelector('tbody').innerHTML='<tr><td>'+Array.from({length:28},(_,i)=>'<button aria-label="'+(i+1)+'일" data-day="'+(i+1)+'">'+(i+1)+'</button>').join('')+'</td></tr>';for(const button of table.querySelectorAll('button'))button.onclick=()=>{dates.push(year+'. '+m+'. '+button.dataset.day);};}
    selected.onclick=()=>{attempts++;dates=['2026. 5. 17','2026. 11. 16'];month=2026*12+10;calendar.hidden=false;render();};
    document.querySelector('#prev').onclick=()=>setTimeout(()=>{month--;render();},80);
    document.querySelector('#next').onclick=()=>setTimeout(()=>{month++;render();},80);
    document.querySelector('#reset').onclick=()=>{dates=[];};
    document.querySelector('#applyCalendar').onclick=()=>{calendar.hidden=true;setTimeout(()=>{selected.textContent=(attempts===1?dates[1]:dates[0])+' ~ '+dates[1];},80);};
    document.querySelector('#applySheet').onclick=()=>{window.applied.push(selected.textContent);sheet.hidden=true;};
    </script>`);
  await selectBaeminDates(page,{from:'2025-11-17',to:'2026-05-16'});
  assert.deepEqual(await page.evaluate(()=>window.applied),['2025. 11. 17 ~ 2026. 5. 16']);
});

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
