import {chromium} from 'playwright-core';
import {writeFile} from 'node:fs/promises';
const b=await chromium.connectOverCDP('http://127.0.0.1:9337');
try{
 const p=b.contexts()[0].pages().find(p=>p.url().endsWith('/management/reviews'));
 if(!await p.getByText('1개월',{exact:true}).isVisible())await p.getByText('오늘',{exact:true}).click();
 await p.getByText('1개월',{exact:true}).click();
 const response=p.waitForResponse(r=>r.url().includes('/reviews/search?')&&r.request().method()==='GET');
 await p.getByRole('button',{name:'조회',exact:true}).click();const data=await (await response).json();
 await p.waitForTimeout(600);
 console.log('reviewui',JSON.stringify({text:(await p.locator('body').innerText()).slice(-6500),rows:await p.locator('tr').evaluateAll(es=>es.slice(0,3).map(e=>e.outerHTML)),buttons:await p.locator('button').evaluateAll(es=>es.map(e=>({text:e.innerText,html:e.outerHTML.slice(0,300)})).slice(-15))}));
 const reply=p.getByRole('button',{name:/댓글|답글/}).first();
 if(await reply.count()){
 await reply.click();console.log('editor',JSON.stringify({text:(await p.locator('body').innerText()).slice(-3000),editors:await p.locator('textarea').evaluateAll(es=>es.map(e=>({html:e.outerHTML,parent:e.parentElement.parentElement.outerHTML}))),buttons:await p.locator('button').evaluateAll(es=>es.map(e=>({text:e.innerText,html:e.outerHTML.slice(0,300)})).slice(-10))}));
 const cancel=p.getByRole('button',{name:'취소',exact:true});for(let i=0;i<await cancel.count();i++)if(await cancel.nth(i).isVisible())await cancel.nth(i).click();
 }
 await p.getByText('티웨스트 동성로점(637947)',{exact:true}).click();
 console.log('stores',JSON.stringify({text:(await p.locator('body').innerText()).slice(-1800),inputs:await p.locator('input:visible').evaluateAll(es=>es.map(e=>e.outerHTML)),items:await p.getByText('베스티',{exact:true}).evaluateAll(es=>es.map(e=>e.parentElement.outerHTML))}));
}finally{await b.close();}
