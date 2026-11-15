import {chromium} from 'playwright-core';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4317');await page.locator('.platform-tabs [data-platform="baemin-teawest"]').click();
 await page.locator('.review-card').first().waitFor();await page.waitForFunction(()=>document.getElementById('baemin-teawest-sidebar-connection')?.textContent.includes('연결됨'));await page.screenshot({path:'.local/delivery-desktop.png',fullPage:true});
 const result=[];
 for(const platform of ['baemin-teawest','baemin-besti','coupangeats-teawest','coupangeats-besti']){
  await page.locator(`.platform-tabs [data-platform="${platform}"]`).click();
  result.push({platform,heading:await page.locator('#platform-heading').innerText(),count:await page.locator('.review-card').count(),wrongShop:await page.locator(`.review-card [class="platform-badge ${platform}"]`).count()!==await page.locator('.review-card').count(),editorMax:await page.locator('#reply-editor').getAttribute('maxlength').catch(()=>null)});
 }
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.local/delivery-mobile.png',fullPage:true});
 console.log(JSON.stringify({result,mobileFits:await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),errors}));
}finally{await browser.close();}
