const base='http://127.0.0.1:4317';
const session=await fetch(`${base}/api/session`).then(r=>r.json());
const state=await fetch(`${base}/api/reviews`).then(r=>r.json());
if(!session.aiConfigured)throw new Error('GPT connection is not configured');
await Promise.all(['baemin-teawest','coupangeats-besti'].map(async platform=>{
 const row=state.reviews.find(r=>r.platform===platform&&!r.hasReply&&r.replyAllowed!==false);
 if(!row)throw new Error('No eligible review for '+platform);
 const response=await fetch(`${base}/api/reviews/${row.id}/suggest`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Review-Token':session.csrf},body:'{}'});
 const result=await response.json();if(!response.ok)throw new Error(result.error);
 console.log(JSON.stringify({platform,length:result.text.length,text:result.text}));
}));
