import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
const b = await chromium.connectOverCDP('http://127.0.0.1:9337');
try {
  const p = b.contexts()[0].pages().find(p => p.url().includes('/shops/14453884/reviews'));
  const close = p.locator('button[aria-label="닫기"]:visible');
  if (await close.count() === 1) await close.click();
  console.log('selects', JSON.stringify(await p.locator('select').evaluateAll(es => es.map(e => ({ value: e.value, options: [...e.options].map(o => ({ value: o.value, text: o.text })) })))));
  const target = p.getByText('리뷰번호 2026111203056515', { exact: true });
  console.log('ancestors', JSON.stringify(await target.evaluate(e => { const out=[]; for(let i=0;e&&i<6;i++,e=e.parentElement) out.push({tag:e.tagName,className:e.className,html:e.outerHTML.slice(0,7000)}); return out; })));
  await p.getByRole('button', { name: '사장님 댓글 등록하기', exact: true }).first().click();
  const snapshot = await p.evaluate(() => ({ text: document.body.innerText, editors: [...document.querySelectorAll('textarea')].map(e => ({html:e.outerHTML, parent:e.parentElement.parentElement.outerHTML})), buttons: [...document.querySelectorAll('button')].filter(e=>e.getClientRects().length).map(e=>({text:e.innerText,label:e.getAttribute('aria-label')})) }));
  await writeFile('.local/baemin-editor-inspection.json', JSON.stringify(snapshot,null,2));
  console.log('editor',JSON.stringify({editors:snapshot.editors,buttons:snapshot.buttons.slice(-20)}));
  const cancel = p.getByRole('button', {name:'취소',exact:true});
  if (await cancel.count() === 1) await cancel.click();
} finally { await b.close(); }
