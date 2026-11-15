import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';

test('delivery UI keeps the two shops separate and confirms the destination with per-shop connection and 300-character limit',async t=>{
 const server=http.createServer(async(req,res)=>{const files={'/':'index.html','/app.js':'app.js','/platforms.js':'platforms.js','/styles.css':'styles.css','/favicon.svg':'favicon.svg'},name=files[req.url];if(!name){res.writeHead(404).end();return;}res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html'});res.end(await readFile(new URL('../public/'+name,import.meta.url)));});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const a={id:'baemin-teawest-1-123',platform:'baemin-teawest',product:'차',content:'티웨스트 후기',rating:5,date:'2026.11.15',author:'고객',storeName:'티웨스트',hasReply:false,replyAllowed:true};
 const b={...a,id:'coupangeats-besti-2-123',platform:'coupangeats-besti',storeName:'베스티',content:'베스티 후기'};const reviews=[a,b],drafts={},posted=[],prepared=[];
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url()),data=req.postData()?req.postDataJSON():{};let result;
 if(url.pathname==='/api/session')result={csrf:'test',settings:{brand:'티웨스트',tone:'따뜻하고 정중하게'},aiConfigured:true};
 else if(url.pathname==='/api/status')result={connected:false,aiConfigured:true,platforms:{'baemin-teawest':{connected:true},'coupangeats-besti':{connected:true}}};
 else if(url.pathname==='/api/reviews')result={reviews,drafts};
 else if(url.pathname.endsWith('/draft')){drafts[url.pathname.split('/')[3]]={text:data.text};result={saved:true};}
 else if(url.pathname.endsWith('/suggest'))result={text:'베스티를 찾아주셔서 감사합니다. 다음에도 맛있게 준비하겠습니다.'};
 else if(url.pathname.endsWith('/prepare')){prepared.push(data);result={text:data.text,token:'confirmed'};}
 else if(url.pathname.endsWith('/publish')){posted.push(url.pathname);b.hasReply=true;b.reply=prepared.at(-1).text;result={success:true,review:b};}
 else throw new Error('Unexpected endpoint '+url.pathname);
 await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('.platform-tabs [data-platform="baemin-teawest"]').click();await page.locator('#reply-editor').fill('티웨스트에만 남길 초안입니다.');
 await page.locator('.platform-tabs [data-platform="coupangeats-besti"]').click();assert.equal(await page.locator('.review-card').count(),1);assert.equal(await page.locator('#reply-editor').inputValue(),'');assert.equal(await page.locator('#reply-editor').getAttribute('maxlength'),'300');
 await page.locator('#generate-button').click();await page.waitForFunction(()=>document.querySelector('#reply-editor')?.value.includes('베스티'));
 assert.equal(posted.length,0);await page.locator('#prepare-publish').click();await page.locator('#publish-dialog[open]').waitFor();assert.match(await page.locator('#confirm-product').innerText(),/쿠팡이츠 · 베스티/);assert.match(await page.locator('#confirm-publish').innerText(),/쿠팡이츠 · 베스티에 등록/);assert.equal(posted.length,0);
 await page.locator('#confirm-publish').click();await page.locator('.posted-reply').waitFor();assert.deepEqual(posted,[`/api/reviews/${b.id}/publish`]);
 await page.locator('.platform-tabs [data-platform="baemin-teawest"]').click();assert.equal(await page.locator('#reply-editor').inputValue(),'티웨스트에만 남길 초안입니다.');assert.equal(await page.locator('#prepare-publish').isEnabled(),true);
 await page.locator('#settings-open').click();assert.equal(await page.locator('#setting-brand').inputValue(),'티웨스트');assert.match(await page.locator('#settings-scope').innerText(),/배민 · 티웨스트/);await page.locator('[data-close="settings-dialog"]').click();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
});
