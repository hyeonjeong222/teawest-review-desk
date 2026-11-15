import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base='http://127.0.0.1:4317';
const before=await fetch(base+'/api/reviews').then(r=>r.json());
const session=await fetch(base+'/api/session').then(r=>r.json());
const unchangedPart = data => JSON.stringify({ reviews:data.reviews.filter(r=>r.platform!=='ably').sort((a,b)=>a.id.localeCompare(b.id)),drafts:data.drafts });
const baseline=unchangedPart(before);
const response=await fetch(base+'/api/sync',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Review-Token':session.csrf},body:JSON.stringify({platform:'ably',period:before.sync?.period||'6m'})});
const after=await response.json(); if(!response.ok) throw new Error(after.error);
assert.equal(unchangedPart(after),baseline);
const ably=after.reviews.filter(r=>r.platform==='ably'), counts=Object.fromEntries(['naver','coupang','ably'].map(p=>[p,after.reviews.filter(r=>(r.platform||'naver')===p).length]));
const status=await fetch(base+'/api/status').then(r=>r.json());
console.log(JSON.stringify({counts,otherReviewsAndDraftsPreserved:true,ablyConnected:status.platforms.ably.connected,aiConfigured:status.aiConfigured,aiKeySaved:status.aiKey?.saved}));
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.locator('.review-card').first().waitFor();
 await page.locator('#connect-ably-sidebar').click();
 assert.equal(await page.locator('.review-card').count(),ably.length);
 assert.equal(await page.locator('#reply-editor,#generate-button,#prepare-publish').count(),0);
 await page.locator('#rating-filter').selectOption('unsatisfied');
 assert.equal(await page.locator('.review-card').count(),ably.filter(r=>r.satisfaction===false).length);
 await page.locator('#rating-filter').selectOption('all');
 const withPhoto=ably.find(r=>r.media.length);
 if(withPhoto){await page.locator(`[data-review="${withPhoto.id}"]`).click();await page.locator('.media-row img').first().scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.media-row img')?.naturalWidth>0,{},{timeout:20000});}
 await page.screenshot({path:'.local/ably-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:'.local/ably-mobile.png',fullPage:true});
 await page.locator('.platform-tabs [data-platform="naver"]').click();assert.equal(await page.locator('.review-card').count(),counts.naver);
 await page.locator('.platform-tabs [data-platform="coupang"]').click();assert.equal(await page.locator('.review-card').count(),counts.coupang);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ui:'passed',photoLoaded:Boolean(withPhoto),screenshots:['.local/ably-desktop.png','.local/ably-mobile.png']}));
}finally{await browser.close();}
