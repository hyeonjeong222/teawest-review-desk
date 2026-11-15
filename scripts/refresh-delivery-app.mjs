const base='http://127.0.0.1:4317';const {csrf}=await fetch(`${base}/api/session`).then(r=>r.json());
const before=await fetch(`${base}/api/reviews`).then(r=>r.json());
await Promise.all(['baemin-teawest','baemin-besti','coupangeats-teawest','coupangeats-besti'].map(async platform=>{
 const response=await fetch(`${base}/api/sync`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Review-Token':csrf},body:JSON.stringify({platform,period:'3m'})});
 const result=await response.json();if(!response.ok)throw new Error(platform+': '+result.error);
 const reviews=result.reviews.filter(r=>r.platform===platform);console.log(JSON.stringify({platform,total:reviews.length,available:reviews.filter(r=>!r.hasReply&&r.replyAllowed!==false).length}));
}));
const after=await fetch(`${base}/api/reviews`).then(r=>r.json());
for(const [id,draft] of Object.entries(before.drafts)){if(!after.reviews.find(r=>r.id===id)?.hasReply&&JSON.stringify(after.drafts[id])!==JSON.stringify(draft))throw new Error('An existing draft changed');}
console.log('Existing drafts preserved; no replies posted.');
