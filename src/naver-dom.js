// Runs in the seller-center review iframe. Only visible review data is read.
export function readRenderedRows() {
  return Array.from(document.querySelectorAll('.ag-center-cols-container [row-id]')).map(row => {
    const cell = name => row.querySelector(`[col-id="${name}"]`);
    const text = name => cell(name)?.innerText.trim() || '';
    const id = text('id') || row.getAttribute('row-id');
    const productId = text('productNo');
    if (!/^\d+$/.test(id || '') || !/^\d+$/.test(productId)) return null;
    const media = Array.from(cell('reviewAttach')?.querySelectorAll('img') || []).map(i => i.src).filter(url => /^https:\/\/[^/]*pstatic\.net\//.test(url));
    return { id, productId, product: text('productName'), content: text('reviewContent'), rating: Number(text('reviewScore')) || 0,
      author: text('maskedWriterId'), date: text('createDate'), type: text('reviewType'), hasReply: /^Y/.test(text('hasComment')),
      replyDate: text('hasComment').match(/\(([^)]+)\)/)?.[1] || null, media, status: text('contentsStatusType'),
      productUrl: `https://smartstore.naver.com/main/products/${productId}#REVIEW` };
  }).filter(Boolean);
}
export function readReviewDetail() {
  const body = document.body.innerText;
  const text = body.slice(body.lastIndexOf('리뷰 상세보기'));
  const field = document.querySelector('textarea[placeholder^="반복적인 답글"]');
  return { id: text.match(/리뷰 글번호\s*(\d+)/)?.[1], option: text.match(/\| 옵션:\s*([^\n]+)/)?.[1] || '',
    reply: field?.value || '', hasReply: Array.from(document.querySelectorAll('button')).some(b => b.getClientRects().length && b.innerText.trim() === '답글 수정') };
}
