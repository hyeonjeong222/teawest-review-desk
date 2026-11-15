import { AppError, assertSameReview } from './core.js';
import { deliveryPlatforms } from '../public/platforms.js';

const origin = 'https://self.baemin.com';
const periods = { '1m': '최근 30일', '3m': '최근 3개월', '6m': '최근 6개월' };
const layout = () => new AppError('배민 리뷰 화면을 확인하지 못했습니다. 기존 리뷰와 초안은 유지됩니다.', 502, 'BAEMIN_LAYOUT');
const login = () => new AppError('배민 연결 창에서 로그인과 추가 인증을 완료해 주세요.', 409, 'DELIVERY_LOGIN_REQUIRED');
const safeId = value => (typeof value === 'string' && /^\d+$/.test(value)) || (Number.isSafeInteger(value) && value > 0);
export function normalizeBaeminReview(raw, platform, shop) {
  if (!safeId(raw.id) || String(raw.shopNumber) !== shop.id || !Number.isInteger(raw.rating) || raw.rating < 1 || raw.rating > 5 || typeof raw.contents !== 'string' || !Array.isArray(raw.comments) || !Array.isArray(raw.menus) || !Array.isArray(raw.images) || typeof raw.writableComment !== 'boolean') throw layout();
  const dateTimestamp = Date.parse(`${raw.createdAt}+09:00`);
  if (!Number.isFinite(dateTimestamp)) throw layout();
  const comments = raw.comments.filter(c => c.displayType === 'CEO');
  if (comments.some(c => typeof c.contents !== 'string')) throw layout();
  return { id: `${platform}-${shop.id}-${raw.id}`, sourceId: String(raw.id), platform, storeId: shop.id, store: `${shop.id} · ${shop.name}`, storeName: shop.name,
    productId: shop.id, product: raw.menus.map(m => m.name).join(' · ') || '주문 메뉴 정보 없음', productUrl: `${origin}/shops/${shop.id}/reviews`,
    content: raw.contents, rating: raw.rating, author: raw.memberNickname ? `${String(raw.memberNickname).slice(0,1)}***` : '고객',
    date: raw.createdAt.slice(0,19).replaceAll('-','.').replace('T',' '), dateTimestamp,
    hasReply: comments.length > 0, reply: comments.length ? comments.map(c=>c.contents).join('\n\n').trim() : null,
    replyAllowed: raw.writableComment, privateReview: raw.displayType !== 'ALL',
    media: raw.images.filter(i=>i.displayStatus === 'DISPLAY' && /^https:\/\/bmreview\.cdn\.baemin\.com\//.test(i.imageUrl)).map(i=>i.imageUrl), readOnly: false };
}

// Reads only the responses produced by the official review UI. Publishing uses its visible form.
export class BaeminConnector {
  constructor(host, platform) { this.host = host; this.platform = platform; this.config = deliveryPlatforms[platform]; }
  async getPage(create = false) {
    const context = (await this.host.connect()).contexts()[0];
    if (this.page && !this.page.isClosed()) return this.page;
    let page = context.pages().find(p=>p.url().startsWith(origin)) || context.pages().find(p=>p.url().startsWith('https://biz-member.baemin.com/'));
    if (!page && create) { page = await context.newPage(); await page.goto(origin, {waitUntil:'domcontentloaded'}); }
    if (!page) throw login();
    return page;
  }
  async shops(page) {
    if (!page.url().startsWith(`${origin}/`)) throw login();
    const options = await page.locator('select option').evaluateAll(es=>es.filter(o=>/^\d+$/.test(o.value)).map(o=>({id:o.value,name:o.textContent.replace(/^\[[^\]]+\]\s*/, '').replace(/\s*\/.*$/, '').trim()})));
    const matches = options.filter(s=>s.name.includes(this.config.brand));
    if (matches.length !== 1) throw new AppError(`${this.config.label} 매장을 하나로 확인할 수 없습니다. 배민 연결 창의 가게 목록을 확인해 주세요.`,409,'STORE_NOT_FOUND');
    if (this.shop && this.shop.id !== matches[0].id) throw new AppError('연결된 배민 매장 번호가 변경되었습니다. 앱을 다시 시작해 연결을 확인해 주세요.',409,'STORE_CHANGED');
    return matches[0];
  }
  async status() {
    try { const page = await this.getPage(); const shop = await this.shops(page); return {connected:true,browserOpen:true,store:`${shop.id} · ${shop.name}`,storeName:shop.name}; }
    catch(e) { return {connected:false,browserOpen:e.code!=='BROWSER_REQUIRED',message:e instanceof AppError?e.message:'배민 연결을 확인해 주세요.'}; }
  }
  async open() {
    try { await this.host.connect(); } catch { await this.host.open(false); }
    let page = await this.getPage(true);
    const shop = await this.shops(page).catch(()=>null);
    if (shop && !page.url().startsWith(`${origin}/shops/${shop.id}/reviews`)) { this.page = await page.context().newPage(); page = this.page; await page.goto(`${origin}/shops/${shop.id}/reviews`,{waitUntil:'domcontentloaded'}); }
    await page.bringToFront(); return this.status();
  }
  async workspace() {
    let page = await this.getPage();
    const shop = await this.shops(page); this.shop = shop;
    if (!this.page || this.page.isClosed()) { this.page = await page.context().newPage(); page = this.page; }
    return {page:this.page,shop};
  }
  async guard(page, shop) {
    if (!page.url().startsWith(`${origin}/shops/${shop.id}/reviews`)) throw new AppError('배민의 선택 매장이 변경되었습니다.',409,'STORE_CHANGED');
    const selected = await page.locator('select').evaluateAll(es=>es.filter(e=>[...e.options].some(o=>o.value === String(e.value) && /^\d+$/.test(o.value))).map(e=>e.value));
    if (selected.length !== 1 || selected[0] !== shop.id) throw new AppError('배민의 선택 매장을 확인하지 못했습니다.',409,'STORE_CHANGED');
  }
  async collect(period = '3m', target = null) {
    if (!periods[period]) throw new AppError('배민은 최근 1·3·6개월 조회를 지원합니다. 조회 기간을 변경해 주세요.',400,'PERIOD_UNSUPPORTED');
    const {page,shop} = await this.workspace();
    if (await page.locator('[class*="ReviewContent-module"] textarea:visible').count()) throw new AppError('배민 연결 창에 열린 답글 입력창을 먼저 닫아 주세요.',409,'UNSAVED_DELIVERY_DRAFT');
    const groups = new Map(), pending = new Set(); let failure;
    const observe = response => {
      const url = new URL(response.url());
      if (url.origin !== 'https://self-api.baemin.com' || !new RegExp(`^/v1/review/shops/${shop.id}/reviews(?:/count)?$`).test(url.pathname) || response.request().method() !== 'GET') return;
      const work = (async()=>{
        if (response.status() !== 200) throw login();
        const data = await response.json(), key = `${url.searchParams.get('from')}/${url.searchParams.get('to')}`;
        const group = groups.get(key) || { rows:new Map(), offsets:new Set(), from:url.searchParams.get('from'),to:url.searchParams.get('to'),total:null,next:true };
        if (url.pathname.endsWith('/count')) { if(!Number.isSafeInteger(data.reviewCount)) throw layout(); group.total=data.reviewCount; }
        else { if(!Array.isArray(data.reviews)||typeof data.next!=='boolean') throw layout(); const offset=Number(url.searchParams.get('offset')); group.offsets.add(offset); for(const raw of data.reviews){const row=normalizeBaeminReview(raw,this.platform,shop); group.rows.set(row.id,row);} group.next=data.next; }
        groups.set(key,group);
      })().catch(e=>{failure=e;}); pending.add(work); work.finally(()=>pending.delete(work));
    };
    page.on('response',observe);
    try {
      await page.goto(`${origin}/shops/${shop.id}/reviews`,{waitUntil:'domcontentloaded'});
      await page.getByRole('button',{name:'필터 페이지시트 열기'}).waitFor({timeout:15000});
      // Close the promotional overlay if present; it is unrelated to reviews.
      const promo=page.getByRole('button',{name:'오늘 하루 보지 않기',exact:true});
      if(await promo.waitFor({state:'visible',timeout:2000}).then(()=>true,()=>false))await promo.click();
      await page.getByRole('button',{name:'필터 페이지시트 열기'}).click();
      await page.locator(`input[name="review-date-filter"][value="${periods[period]}"]`).check();
      await page.getByRole('button',{name:'적용',exact:true}).click();
      let lastSize=-1,stalled=0;
      for(let step=0;step<400;step++) {
        await page.waitForTimeout(200); await Promise.all([...pending]); if(failure) throw failure;
        await this.guard(page,shop);
        const filterText=await page.locator('button[aria-label="필터 페이지시트 열기"]').innerText();
        const dates=[...filterText.matchAll(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/g)].map(m=>`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
        const group=groups.get(dates.join('/'));
        if(process.env.DELIVERY_DEBUG && step%20===0)console.log(JSON.stringify({step,dates,groups:[...groups].map(([key,g])=>({key,size:g.rows.size,total:g.total,next:g.next}))}));
        if(group) {
          const found=target && group.rows.get(target.id);
          if(found){assertSameReview(target,found);return {page,shop,actual:found};}
          if(group.total!==null && group.rows.size===group.total && (group.total===0||!group.next)) return {reviews:[...group.rows.values()],total:group.total,store:`${shop.id} · ${shop.name}`,storeName:shop.name,period,from:group.from,to:group.to};
          stalled=group.rows.size===lastSize?stalled+1:0;lastSize=group.rows.size;
          if(stalled>35) throw new AppError('배민 리뷰를 모두 읽지 못했습니다. 기존 목록을 유지합니다. 다시 가져와 주세요.',502,'INCOMPLETE_SYNC');
        }
        await page.evaluate(()=>{window.scrollTo(0,document.documentElement.scrollHeight);for(const e of document.querySelectorAll('main, [class*="ReviewList"], [class*="Content"]'))if(e.scrollHeight>e.clientHeight && ['auto','scroll'].includes(getComputedStyle(e).overflowY))e.scrollTop=e.scrollHeight;});
      }
      throw layout();
    }finally{page.off('response',observe);await Promise.all([...pending]);}
  }
  async sync(period) { return this.collect(period); }
  async locate(expected) {
    if(expected.platform!==this.platform)throw new AppError('선택한 매장이 다릅니다.',409,'STORE_CHANGED');
    const located=await this.collect('6m',expected);
    if(!located.actual)throw new AppError('배민에서 해당 리뷰를 찾지 못했습니다. 최근 리뷰를 다시 가져와 주세요.',409,'REVIEW_CHANGED');
    return located;
  }
  async detail(expected) { return (await this.locate(expected)).actual; }
  card(page, expected) { return page.locator('[class*="ReviewContent-module"]').filter({has:page.getByText(`리뷰번호 ${expected.sourceId}`,{exact:true})}); }
  async fill(expected,text) {
    const located=await this.locate(expected),{page,shop,actual}=located;
    if(actual.hasReply)throw new AppError('이미 답글이 등록되어 있습니다. 답글 확인을 눌러 주세요.',409,'ALREADY_REPLIED');
    if(!actual.replyAllowed)throw new AppError('배민에서 이 리뷰의 댓글 등록을 허용하지 않습니다.',409,'REPLY_UNAVAILABLE');
    const card=this.card(page,expected); if(await card.count()!==1)throw layout();
    await card.getByRole('button',{name:'사장님 댓글 등록하기',exact:true}).click();
    const editor=card.locator('textarea'); await editor.fill(text); await this.guard(page,shop);
    if(await editor.inputValue()!==text || !(await card.innerText()).includes(`리뷰번호 ${expected.sourceId}`))throw layout();
    return {...located,card,editor};
  }
  async publish(expected,text,beforeClick) {
    const {page,shop,card,editor}=await this.fill(expected,text);
    await this.guard(page,shop); if(await editor.inputValue()!==text)throw layout();
    const button=card.getByRole('button',{name:'등록',exact:true}); if(await button.count()!==1||await button.isDisabled())throw layout();
    await beforeClick(); await button.click();
    await editor.waitFor({state:'hidden',timeout:15000});
    const actual=await this.detail(expected);
    if(!actual.hasReply||actual.reply!==text.trim())throw new Error('Reply read-back mismatch');
    return {reply:actual.reply};
  }
}
