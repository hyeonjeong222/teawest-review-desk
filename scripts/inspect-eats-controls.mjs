import { chromium } from 'playwright-core';
import {writeFile} from 'node:fs/promises';
const b=await chromium.connectOverCDP('http://127.0.0.1:9337');
try{
const p=b.contexts()[0].pages().find(p=>p.url().endsWith('/management/reviews'));
const responses=[];p.on('response',async r=>{if(/json/.test(r.headers()['content-type']||'')){try{responses.push({url:r.url(),method:r.request().method(),data:await r.json()});}catch{}}});
await p.reload({waitUntil:'domcontentloaded'});await p.waitForTimeout(2500);
console.log(JSON.stringify({text:(await p.locator('body').innerText()).slice(-5500),resources:await p.evaluate(()=>performance.getEntriesByType('resource').filter(r=>['fetch','xmlhttprequest'].includes(r.initiatorType)).map(r=>r.name)),selects:await p.locator('[role],select,.Select-control').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>({tag:e.tagName,role:e.getAttribute('role'),text:e.innerText,html:e.outerHTML.slice(0,2500)})))}));
await writeFile('.local/coupangeats-responses.json',JSON.stringify(responses,null,2));
}finally{await b.close();}
