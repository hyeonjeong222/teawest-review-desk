import {chromium} from 'playwright-core';
const b=await chromium.connectOverCDP('http://127.0.0.1:9337');
try{
 const p=b.contexts()[0].pages().find(p=>p.url().endsWith('/management/reviews'));
 // Intercept every review mutation before touching the register button; no request can reach the server.
 const blocked=[];
 const guard=async route=>{const r=route.request();if(!['GET','HEAD','OPTIONS'].includes(r.method())){blocked.push({url:r.url(),method:r.method(),body:r.postDataJSON()});await route.abort('blockedbyclient');}else await route.continue();};
 await p.route('**/api/**/reviews/**',guard);
 try{
 const expanded=p.getByText('베스티(867981)',{exact:true}); if(await expanded.isVisible()) await p.getByText('티웨스트 동성로점(637947)',{exact:true}).first().click();
 const row=p.locator('tr').filter({hasText:'06LMCM'});await row.getByRole('button',{name:'사장님 댓글 등록하기',exact:true}).click();
 const editor=p.locator('textarea[name="review"]');await editor.fill('연동 검증용 임시 문구입니다. 네트워크에서 등록을 차단합니다.');
 const form=editor.locator('xpath=ancestor::tr');await form.getByRole('button',{name:'등록',exact:true}).click();await p.waitForTimeout(1000);
 console.log(JSON.stringify({blocked,text:(await p.locator('body').innerText()).slice(-900)}));
 await editor.fill('');await form.getByRole('button',{name:'취소',exact:true}).click();
 }finally{await p.unroute('**/api/**/reviews/**',guard);}
}finally{await b.close();}
