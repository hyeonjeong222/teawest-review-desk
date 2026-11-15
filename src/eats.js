import {AppError, assertSameReview} from './core.js';
import {deliveryPlatforms} from '../public/platforms.js';
import {coupangDateRange, coupangDateWindows} from './coupang.js';
const origin='https://store.coupangeats.com', reviewURL=origin+'/merchant/management/reviews';
const storePath='/api/v1/merchant/web/stores/list-by-pagination?pageSize=2000&pageNum=0';
const searchPath='/api/v1/merchant/reviews/search';
const login=()=>new AppError('쿠팡이츠 연결 창에서 로그인과 추가 인증을 완료해 주세요.',409,'DELIVERY_LOGIN_REQUIRED');
const layout=()=>new AppError('쿠팡이츠 리뷰 화면을 확인하지 못했습니다. 기존 리뷰와 초안은 유지됩니다.',502,'EATS_LAYOUT');
export function normalizeEatsReview(raw,platform,shop){
 if(!Number.isSafeInteger(raw.orderReviewId)||String(raw.storeId)!==shop.id||typeof raw.comment!=='string'||!Number.isInteger(raw.rating)||raw.rating<1||raw.rating>5||!Array.isArray(raw.orderInfo)||!Array.isArray(raw.replies)||!Array.isArray(raw.images))throw layout();
 const dateTimestamp=Date.parse(`${raw.createdAt}+09:00`);if(!Number.isFinite(dateTimestamp))throw layout();
 if(raw.replies.some(r=>typeof r.content!=='string'))throw layout();
 const reply=raw.replies.map(r=>r.content).join('\n\n').trim();
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
 const ageDays=(Date.parse(today)-Date.parse(raw.createdAt.slice(0,10)))/86400000;
 return {id:`${platform}-${shop.id}-${raw.orderReviewId}`,sourceId:String(raw.orderReviewId),platform,storeId:shop.id,store:`${shop.id} · ${shop.name}`,storeName:shop.name,
 productId:shop.id,product:raw.orderInfo.map(m=>m.dishName).join(' · ')||'주문 메뉴 정보 없음',productUrl:reviewURL,
 content:raw.comment,rating:raw.rating,author:raw.customerName?`${String(raw.customerName).slice(0,1)}***`:'고객',
 date:raw.createdAt.slice(0,19).replaceAll('-','.').replace('T',' '),dateTimestamp,hasReply:raw.replies.length>0,reply:reply||null,replyAllowed:!['BLIND','SUSPEND'].includes(raw.statusType)&&ageDays<14,replyMaxLength:300,
 media:raw.images.map(i=>typeof i==='string'?i:i.imageUrl).filter(u=>typeof u==='string'&&/^https:\/\/[^/]+\.coupangcdn\.com\//.test(u)),readOnly:false};
}
export class EatsConnector{
 constructor(host,platform){this.host=host;this.platform=platform;this.config=deliveryPlatforms[platform];}
 async getPage(create=false){
  if(this.page&&!this.page.isClosed())return this.page;
  const context=(await this.host.connect()).contexts()[0];let page=context.pages().find(p=>p.url().startsWith(origin+'/merchant/management'))||context.pages().find(p=>p.url().startsWith(origin+'/'));
  if(!page&&create){page=await context.newPage();await page.goto(origin+'/merchant/login',{waitUntil:'domcontentloaded'});}
  if(!page)throw login();return page;
 }
 async get(page,path){
  if(!page.url().startsWith(origin+'/merchant/management'))throw login();
  const result=await page.evaluate(async path=>{const response=await fetch(path,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(20000)});return {status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():null};},path);
  if([401,403].includes(result.status)||!result.data)throw login();
  if(result.status!==200||result.data.code!=='SUCCESS')throw new AppError('쿠팡이츠 리뷰 서버에서 조회를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',502,'EATS_SEARCH_FAILED');
  return result.data.data;
 }
 async shopFor(page){
  const data=await this.get(page,storePath);
  if(!Array.isArray(data?.data)||data.totalPages!==1)throw layout();
  const choices=data.data.filter(s=>typeof s.name==='string'&&s.name.includes(this.config.brand));
  if(choices.length!==1||!Number.isSafeInteger(choices[0].id))throw new AppError(`${this.config.label} 매장을 하나로 확인할 수 없습니다. 쿠팡이츠의 매장 목록을 확인해 주세요.`,409,'STORE_NOT_FOUND');
  const shop={id:String(choices[0].id),name:choices[0].name};
  if(this.shop&&this.shop.id!==shop.id)throw new AppError('쿠팡이츠 매장 번호가 변경되었습니다. 연결을 다시 확인해 주세요.',409,'STORE_CHANGED');
  this.shop=shop;return shop;
 }
 async status(){try{const page=await this.getPage();if(!this.probe||Date.now()-this.probe.at>60000){const shop=await this.shopFor(page);this.probe={at:Date.now(),shop};}const shop=this.probe.shop;return {connected:true,browserOpen:true,store:`${shop.id} · ${shop.name}`,storeName:shop.name};}catch(e){return {connected:false,browserOpen:e.code!=='BROWSER_REQUIRED',message:e instanceof AppError?e.message:'쿠팡이츠 연결을 확인해 주세요.'};}}
 async open(){try{await this.host.connect();}catch{await this.host.open(false);}let page=await this.getPage(true);const shop=await this.shopFor(page).catch(()=>null);if(shop&&page.url()!==`${reviewURL}/${shop.id}`){this.page=await page.context().newPage();page=this.page;await page.goto(`${reviewURL}/${shop.id}`,{waitUntil:'domcontentloaded'});}await page.bringToFront();this.probe=null;return this.status();}
 async workspace(){const page=await this.getPage();const shop=await this.shopFor(page);return {page,shop};}
 async search(page,shop,from,to,index=1){
  const query=new URLSearchParams({storeId:shop.id,page:String(index),statusType:'EXPOSE',startDateTime:from,exclusiveEndDateTime:to,size:'5'});
  const data=await this.get(page,`${searchPath}?${query}`);
  if(!Array.isArray(data?.content)||!Number.isSafeInteger(data.total)||data.total<0||data.content.some(r=>String(r.storeId)!==shop.id))throw layout();return data;
 }
 async range(page,shop,from,to,target){
  const rows=new Map();let total;
  for(let index=1;index<=400;index++){
   const data=await this.search(page,shop,from,to,index);if(total===undefined)total=data.total;if(data.total!==total)throw new AppError('조회 중 쿠팡이츠 리뷰 건수가 변경되었습니다. 다시 가져와 주세요.',409,'INCOMPLETE_SYNC');
   for(const raw of data.content){const row=normalizeEatsReview(raw,this.platform,shop);if(rows.has(row.id))throw layout();rows.set(row.id,row);if(target&&row.id===target.id){assertSameReview(target,row);return {actual:row,raw};}}
   if(rows.size===total)return {reviews:[...rows.values()],total};if(!data.content.length)break;
  }
  throw new AppError('쿠팡이츠 리뷰를 모두 읽지 못했습니다. 기존 목록은 유지됩니다.',502,'INCOMPLETE_SYNC');
 }
 async syncRange(range,period='3m'){return this.sync(period,range);}
 async sync(period='3m',range=coupangDateRange(period)){
  const {page,shop}=await this.workspace(),{from,to}=range,rows=new Map();
  for(const window of coupangDateWindows(from,to)){
   // The portal's end date is inclusive despite the parameter name.
   const result=await this.range(page,shop,window.from,window.to);
   for(const row of result.reviews){if(rows.has(row.id))throw layout();rows.set(row.id,row);}
  }
  const after=await this.shopFor(page);if(after.id!==shop.id)throw layout();
  return {reviews:[...rows.values()],total:rows.size,store:`${shop.id} · ${shop.name}`,storeName:shop.name,from,to,period};
 }
 async detail(expected){
  if(expected.platform!==this.platform)throw new AppError('선택한 매장이 다릅니다.',409,'STORE_CHANGED');
  const {page,shop}=await this.workspace();if(shop.id!==expected.storeId)throw new AppError('선택한 매장이 다릅니다.',409,'STORE_CHANGED');
  const date=expected.date.slice(0,10).replaceAll('.','-');
  const found=await this.range(page,shop,date,date,expected);if(!found.actual)throw new AppError('쿠팡이츠에서 해당 리뷰를 찾지 못했습니다.',409,'REVIEW_CHANGED');return found.actual;
 }
 async guard(page,shop){
  if(![reviewURL,`${reviewURL}/${shop.id}`].includes(page.url()))throw new AppError('쿠팡이츠 리뷰 화면이 변경되었습니다.',409,'STORE_CHANGED');
  const labels=await page.locator('.button').allTextContents();
  if(!labels.some(t=>t.trim()===`${shop.name}(${shop.id})`))throw new AppError('쿠팡이츠의 선택 매장이 다릅니다.',409,'STORE_CHANGED');
 }
 async fill(expected,text){
  if(text.length>300)throw new AppError('쿠팡이츠 답글은 300자 이하로 작성해 주세요.');
  const actual=await this.detail(expected);if(actual.hasReply)throw new AppError('이미 답글이 등록되어 있습니다.',409,'ALREADY_REPLIED');
  if(!actual.replyAllowed)throw new AppError('쿠팡이츠는 작성일 기준 14일 이내 리뷰에 댓글을 등록할 수 있습니다.',409,'REPLY_UNAVAILABLE');
  let {page,shop}=await this.workspace();
  if(!this.page||this.page.isClosed()){this.page=await page.context().newPage();page=this.page;}
  if(await page.locator('textarea[name="review"]:visible').count())throw new AppError('쿠팡이츠 연결 창의 답글 입력창을 먼저 닫아 주세요.',409,'UNSAVED_DELIVERY_DRAFT');
  await page.goto(reviewURL,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'조회',exact:true}).waitFor();
  const selected=page.locator('.button').filter({hasText:/\(\d+\)/});
  if(await selected.count()!==1)throw layout();
  if((await selected.innerText()).trim()!==`${shop.name}(${shop.id})`){await selected.click();await page.getByText(`${shop.name}(${shop.id})`,{exact:true}).click();}
  await page.waitForFunction(({name,id})=>[...document.querySelectorAll('.button')].some(e=>e.innerText.trim()===`${name}(${id})`),shop);
  await this.guard(page,shop);
  await page.getByText('오늘',{exact:true}).click();
  const age=(Date.now()-expected.dateTimestamp)/86400000,period=age<28?'1개월':age<85?'3개월':age<175?'6개월':'1년';
  await page.getByText(period,{exact:true}).click();
  const waitSearch=()=>page.waitForResponse(r=>{const u=new URL(r.url());return u.origin===origin&&u.pathname===searchPath&&u.searchParams.get('storeId')===shop.id&&r.request().method()==='GET';},{timeout:20000});
  let pending=waitSearch();await page.getByRole('button',{name:'조회',exact:true}).click();
  for(let index=1;index<=400;index++){
   const response=await pending,body=await response.json();if(response.status()!==200||body.code!=='SUCCESS'||!Array.isArray(body.data?.content))throw layout();
   const data=body.data,raw=data.content.find(r=>String(r.orderReviewId)===expected.sourceId);
   if(raw){
    const fresh=normalizeEatsReview(raw,this.platform,shop);assertSameReview(expected,fresh);if(fresh.hasReply)throw new AppError('이미 답글이 등록되어 있습니다.',409,'ALREADY_REPLIED');
    if(typeof raw.abbrOrderId!=='string'||!raw.abbrOrderId)throw layout();
    const card=page.locator('tr').filter({hasText:raw.abbrOrderId});await card.waitFor();if(await card.count()!==1)throw layout();
    const content=(await card.innerText()).replace(/\s+/g,' ');if(!content.includes(raw.createdAt.slice(0,10))||!content.includes(raw.comment.replace(/\s+/g,' ')))throw layout();
    await card.getByRole('button',{name:'사장님 댓글 등록하기',exact:true}).click();
    const editor=page.locator('textarea[name="review"]');if(await editor.count()!==1)throw layout();
    // The portal renders the editor in the immediate following table row.
    const form=card.locator('xpath=following-sibling::tr[1]');if(await form.locator('textarea[name="review"]').count()!==1)throw layout();
    await editor.fill(text);await this.guard(page,shop);if(await editor.inputValue()!==text)throw layout();
    return {page,shop,card,form,editor,raw};
   }
   if(index*5>=data.total)break;
   const next=page.getByRole('button',{name:String(index+1),exact:true});pending=waitSearch();
   if(await next.isVisible())await next.click();else await page.locator('[data-at="next-btn"]').click();
  }
  throw new AppError('쿠팡이츠 화면에서 해당 리뷰를 찾지 못했습니다.',409,'REVIEW_CHANGED');
 }
 async publish(expected,text,beforeClick){
  const {page,shop,card,form,editor,raw}=await this.fill(expected,text);await this.guard(page,shop);
  if(await editor.inputValue()!==text||!(await card.innerText()).includes(raw.abbrOrderId))throw layout();
  const button=form.getByRole('button',{name:'등록',exact:true});if(await button.count()!==1||await button.isDisabled())throw layout();
  await beforeClick();await button.click();await editor.waitFor({state:'hidden',timeout:15000});
  const verified=await this.detail(expected);if(!verified.hasReply||verified.reply!==text.trim())throw new Error('Reply read-back mismatch');return {reply:verified.reply};
 }
}
