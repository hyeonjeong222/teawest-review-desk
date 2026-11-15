import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9337');
try {
 const p=b.contexts()[0].pages().find(p=>p.url().includes('/shops/14453884/reviews'));
 await p.locator('input[value="날짜 직접 선택"]').check();
 console.log(JSON.stringify(await p.locator('input:visible,button:visible').evaluateAll(es=>es.map(e=>({tag:e.tagName,text:e.innerText,type:e.type,placeholder:e.getAttribute('placeholder'),label:e.getAttribute('aria-label'),html:e.tagName==='INPUT'?e.outerHTML:null})).slice(-30))));
}finally{await b.close();}
