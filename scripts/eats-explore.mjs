import { chromium } from 'playwright-core';
import {writeFile} from 'node:fs/promises';
const b=await chromium.connectOverCDP('http://127.0.0.1:9337');
try{
const p=b.contexts()[0].pages().find(p=>p.url().endsWith('/management/reviews'));
console.log('today',await p.getByText('오늘',{exact:true}).evaluate(e=>e.outerHTML+'\n'+e.parentElement.outerHTML));
console.log('store',await p.getByText('티웨스트 동성로점(637947)',{exact:true}).evaluate(e=>e.outerHTML+'\n'+e.parentElement.outerHTML));
await p.getByText('오늘',{exact:true}).click();
console.log('date',JSON.stringify({text:(await p.locator('body').innerText()).slice(-2400),elements:await p.locator('input:visible,button:visible,li:visible').evaluateAll(es=>es.map(e=>({tag:e.tagName,text:e.innerText,html:e.outerHTML.slice(0,800)})).slice(-35))}));
const r=await p.evaluate(async()=>{const res=await fetch('/api/v1/merchant/reviews/search?storeId=637947&page=1&statusType=EXPOSE&startDateTime=2026-10-15&exclusiveEndDateTime=2026-11-16&size=5');return {status:res.status,data:res.headers.get('content-type')?.includes('json')?await res.json():null};});
await writeFile('.local/eats-review-sample.json',JSON.stringify(r,null,2));console.log('read',{status:r.status,keys:Object.keys(r.data||{})});
}finally{await b.close();}
