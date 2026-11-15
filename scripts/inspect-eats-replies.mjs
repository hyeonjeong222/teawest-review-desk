import {chromium} from 'playwright-core';
import {writeFile} from 'node:fs/promises';
const b=await chromium.connectOverCDP('http://127.0.0.1:9337');
try{
 const p=b.contexts()[0].pages().find(p=>p.url().endsWith('/management/reviews'));
 await p.reload({waitUntil:'domcontentloaded'});await p.getByText('오늘',{exact:true}).click();await p.getByText('1년',{exact:true}).click();
 const responses=[];p.on('response',async r=>{if(r.url().includes('/reviews/search?'))responses.push({url:r.url(),data:await r.json()});});
 await p.getByRole('button',{name:'조회',exact:true}).click();await p.waitForTimeout(700);await p.getByText('답변',{exact:true}).click();await p.waitForTimeout(700);
 await writeFile('.local/eats-replies.json',JSON.stringify(responses,null,2));console.log(JSON.stringify(responses.map(r=>({url:r.url(),data:r.data}))));
}finally{await b.close();}
