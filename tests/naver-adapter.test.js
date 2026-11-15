import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { NaverConnector, dismissReplySuccess } from '../src/naver.js';

test('shared browser attaches once for simultaneous store checks and recovers after failure or disconnect', async t => {
  const connector = new NaverConnector('unused-test-profile');
  let complete, fail, connected = true;
  const browser = { isConnected: () => connected };
  const attach = t.mock.method(chromium, 'connectOverCDP', () => new Promise((resolve, reject) => { complete = resolve; fail = reject; }));
  const first = Array.from({ length: 7 }, () => connector.connect());
  assert.equal(attach.mock.callCount(), 1);
  fail(new Error('Temporary browser interruption'));
  assert.ok((await Promise.allSettled(first)).every(result => result.status === 'rejected' && result.reason.code === 'BROWSER_REQUIRED'));
  const retry = Array.from({ length: 7 }, () => connector.connect());
  assert.equal(attach.mock.callCount(), 2); complete(browser);
  assert.ok((await Promise.all(retry)).every(result => result === browser));
  assert.equal(await connector.connect(), browser); assert.equal(attach.mock.callCount(), 2);
  connected = false;
  const reopened = connector.connect(); assert.equal(attach.mock.callCount(), 3);
  connected = true; complete(browser); assert.equal(await reopened, browser);
});

test('Naver sync distinguishes a confirmed empty result from an unreadable review count', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.setContent(fixture);
  const connector = new NaverConnector('unused-test-profile');
  connector.workspace = async () => ({ page, frame: page.mainFrame(), store: '테스트 스토어' });
  await page.locator('#background > p').evaluate(el => { el.textContent = '리뷰목록'; });
  await page.locator('.ag-center-cols-container').evaluate(el => el.replaceChildren());
  await assert.rejects(connector.sync('3m'), error => error.code === 'NAVER_LAYOUT');
  await page.locator('#background > p').evaluate(el => { el.textContent = '리뷰목록 (총 0개)'; });
  const result = await connector.sync('3m'); assert.equal(result.total, 0); assert.deepEqual(result.reviews, []);
});

test('Naver sync waits for delayed final rows in a virtual scrolling grid', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.setContent(fixture);
  await page.evaluate(() => {
    document.querySelector('#background > p').textContent = '리뷰목록 (총 2개)';
    const container = document.querySelector('.ag-center-cols-container');
    const viewport = document.createElement('div'); viewport.className = 'ag-body-viewport'; viewport.style = 'height:100px;overflow:auto';
    container.before(viewport); viewport.append(container); container.style.height = '300px';
    let scheduled = false;
    viewport.addEventListener('scroll', () => {
      if (scheduled || viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight) return;
      scheduled = true; setTimeout(() => { const row = container.firstElementChild.cloneNode(true); row.setAttribute('row-id', '1234567891'); row.querySelector('[col-id=id]').textContent = '1234567891'; container.replaceChildren(row); }, 300);
    });
  });
  const connector = new NaverConnector('unused-test-profile');
  connector.workspace = async () => ({ page, frame: page.mainFrame(), store: '테스트 스토어' });
  const result = await connector.sync('3m'); assert.equal(result.total, 2); assert.equal(result.reviews.length, 2);
  assert.deepEqual(result.reviews.map(r => r.id), ['1234567890', '1234567891']);
});

test('Naver adapter: exact-review posting, saved-text read-back, and duplicate guard on an isolated seller UI fixture', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
  await page.goto('http://naver-fixture.test/');
  const connector = new NaverConnector('unused-test-profile');
  connector.workspace = async () => ({ page, frame: page.mainFrame(), store: '테스트 스토어' });
  const review = { id: '1234567890', productId: '4321', product: '쿠키도우', rating: 5, content: '정말 맛있어요.', store: '테스트 스토어', hasReply: false };
  let beforeClicks = 0;
  const result = await connector.publish(review, '맛있게 드셔주셔서 감사합니다. 달콤한 하루 보내세요!', async () => { beforeClicks++; });
  assert.equal(beforeClicks, 1); assert.equal(result.reply, '맛있게 드셔주셔서 감사합니다. 달콤한 하루 보내세요!');
  assert.equal(await page.evaluate(() => window.submits), 1);
  assert.equal(await page.evaluate(() => window.acknowledged), 1);
  await assert.rejects(connector.publish(review, '다른 답글입니다. 감사합니다!', async () => { beforeClicks++; }), e => e.code === 'ALREADY_REPLIED');
  assert.equal(beforeClicks, 1); assert.equal(await page.evaluate(() => window.submits), 1);
  await assert.rejects(connector.publish({ ...review, store: '다른 스토어' }, '후기 감사합니다.', async () => { beforeClicks++; }), e => e.code === 'STORE_CHANGED');
  assert.equal(await page.evaluate(() => window.submits), 1);
  await page.evaluate(() => { const notice = document.createElement('div'); notice.className = 'mst-modal-root'; notice.innerHTML = '<p>답글을 등록하시겠습니까?</p><button>확인</button>'; notice.querySelector('button').onclick = () => window.submits++; document.body.appendChild(notice); });
  assert.equal(await dismissReplySuccess(page.mainFrame()), false); assert.equal(await page.evaluate(() => window.submits), 1);
});
const fixture = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"></head><body>
<div id="background">
<button id="reset">초기화</button><button>1개월</button><button>3개월</button><button>6개월</button><button>1년</button>
<div role="combobox">리뷰글번호</div><textarea placeholder='복수 검색시 enter 또는 ","로 구분하세요.'></textarea><button id="search">검색</button>
<p>리뷰목록 (총 1개)</p><div class="ag-center-cols-container"><div row-id="1234567890"><div col-id="id">1234567890</div><div col-id="productNo">4321</div><div col-id="productName">쿠키도우</div><div col-id="reviewScore">5</div><div col-id="reviewContent"><a role="button" id="review">정말 맛있어요.</a></div><div col-id="hasComment" id="status">N</div></div></div><div id="popup"></div></div><button hidden>확인</button>
<script>
window.saved='';window.submits=0;window.acknowledged=0;
document.querySelector('#reset').onclick=()=>{document.querySelector('textarea').value='';};
document.querySelector('#review').onclick=openDetail;
function openDetail(){const p=document.querySelector('#popup');p.innerHTML='<h2>리뷰 상세보기</h2><p>리뷰 글번호 1234567890</p><p>상품명: 쿠키도우 | 옵션: 바닐라</p><textarea placeholder="반복적인 답글이 아닌 정성스러운 답글을 남겨주세요."></textarea><button id="submit">'+(window.saved?'답글 수정':'답글 등록')+'</button><button id="close">닫기</button>';p.querySelector('textarea').value=window.saved;document.querySelector('#close').onclick=()=>p.replaceChildren();document.querySelector('#submit').onclick=()=>{window.saved=p.querySelector('textarea').value;window.submits++;document.querySelector('#status').textContent='Y';p.replaceChildren();document.querySelector('#background').setAttribute('aria-hidden','true');const notice=document.createElement('div');notice.className='mst-modal-root';notice.style='width:0;height:0;overflow:visible';notice.innerHTML='<div style="position:fixed;top:20px;left:20px;background:white">답글이 등록되었습니다.<button>확인</button></div>';document.body.appendChild(notice);notice.querySelector('button').onclick=()=>{window.acknowledged++;notice.remove();document.querySelector('#background').removeAttribute('aria-hidden');};};}
</script></body></html>`;
