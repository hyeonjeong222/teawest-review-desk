import {AppError, fingerprint, reviewPlatform, sortReviews} from './core.js';

const dayMs=86400000;
export const isoDay=value=>{
  const match=String(value||'').match(/(\d{4})[.-](\d{1,2})[.-](\d{1,2})/);
  if(!match)return null;
  const day=`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;
  const timestamp=Date.parse(day+'T00:00:00Z');
  return Number.isFinite(timestamp)&&new Date(timestamp).toISOString().slice(0,10)===day?day:null;
};
export const shiftDay=(day,offset)=>new Date(Date.parse(day+'T00:00:00Z')+offset*dayMs).toISOString().slice(0,10);
export function reviewRange(period,now=new Date()) {
  const months={'1m':1,'3m':3,'6m':6,'1y':12}[period];
  if(!months)throw new AppError('지원하지 않는 조회 기간입니다.');
  const to=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const from=new Date(to+'T00:00:00Z'),day=from.getUTCDate();
  from.setUTCDate(1);from.setUTCMonth(from.getUTCMonth()-months);
  from.setUTCDate(Math.min(day,new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth()+1,0)).getUTCDate()));
  return {from:shiftDay(from.toISOString().slice(0,10),1),to};
}
const validRange=r=>r&&isoDay(r.from)===r.from&&isoDay(r.to)===r.to&&r.from<=r.to;
export function mergeRanges(ranges) {
  const merged=[];
  for(const range of ranges.filter(validRange).sort((a,b)=>a.from.localeCompare(b.from))) {
    const last=merged.at(-1);
    if(last&&range.from<=shiftDay(last.to,1))last.to=last.to>range.to?last.to:range.to;
    else merged.push({...range});
  }
  return merged;
}
export function missingRanges(range,coverage=[]) {
  const missing=[];let start=range.from;
  for(const covered of mergeRanges(coverage)) {
    if(covered.to<start)continue;if(covered.from>range.to)break;
    if(covered.from>start)missing.push({from:start,to:shiftDay(covered.from,-1)});
    if(covered.to>=range.to)return missing;
    start=shiftDay(covered.to,1);
  }
  if(start<=range.to)missing.push({from:start,to:range.to});
  return missing;
}
export function retainReviewArchive(state) {
  const rows=new Map((state.reviewArchive||[]).map(row=>[row.id,row]));
  for(const row of state.reviews)rows.set(row.id,{...row});
  state.reviewArchive=[...rows.values()];
}
export function hydrateReviewCache(state) {
  state.reviewArchive ||= [];state.reviewCache ||= {};retainReviewArchive(state);
  for(const [platform,meta] of Object.entries({...state.syncs,...(!state.syncs?.naver&&state.sync?{naver:state.sync}:{})})) {
    const range={from:isoDay(meta.from),to:isoDay(meta.to)};
    const count=state.reviews.filter(row=>reviewPlatform(row)===platform&&row.store===meta.store).length;
    if(!state.reviewCache[platform]&&meta.store&&meta.lastSync&&count===meta.total&&validRange(range))state.reviewCache[platform]={store:meta.store,coverage:[range],lastSync:meta.lastSync,auditAt:meta.lastSync,auditCursor:range.from};
  }
}
function visibleRows(rows,platform,store,range) {
  return sortReviews(rows.filter(row=>reviewPlatform(row)===platform&&row.store===store&&!row.sourceRemovedAt&&isoDay(row.date)>=range.from&&isoDay(row.date)<=range.to).map(row=>({...row,...(!['coupang','ably'].includes(platform)?{fingerprint:fingerprint(row)}:{})})));
}
export function selectCachedPeriod(state,platform,period,now=new Date()) {
  const cache=state.reviewCache?.[platform],range=reviewRange(period,now);
  if(!cache||missingRanges(range,cache.coverage).length)return false;
  const reviews=visibleRows(state.reviewArchive||[],platform,cache.store,range);
  state.reviews=sortReviews([...state.reviews.filter(row=>reviewPlatform(row)!==platform),...reviews]);
  const meta={...state.syncs?.[platform],store:cache.store,period,...range,total:reviews.length,mode:'cache'};
  state.syncs={...state.syncs,[platform]:meta};if(platform==='naver')state.sync=meta;
  return true;
}
export function commitReviewCache(state,platform,result) {
  const update=result.cacheUpdate;if(!update)return;
  state.reviewArchive=[...(state.reviewArchive||[]).filter(row=>reviewPlatform(row)!==platform||row.store!==update.cache.store),...update.rows];
  state.reviewCache={...state.reviewCache,[platform]:update.cache};
}
export function planReviewRefresh(cache,platform,range,{full=false,now=new Date()}={}) {
  const missing=missingRanges(range,cache?.coverage);
  if(full||!cache)return {ranges:[range],mode:'full',auditAt:now.toISOString(),auditCursor:range.from};
  const lookback=['coupang'].includes(platform)?7:31;
  let recentFrom=shiftDay(range.to,-lookback+1);
  const previous=isoDay(cache.lastSync);if(previous&&shiftDay(previous,-2)<recentFrom)recentFrom=shiftDay(previous,-2);
  if(recentFrom<range.from)recentFrom=range.from;
  const ranges=[...missing,{from:recentFrom,to:range.to}];
  let auditAt=cache.auditAt,auditCursor=cache.auditCursor;
  if(!missing.length&&now.getTime()-(Date.parse(auditAt)||0)>=600000&&range.from<recentFrom) {
    const from=auditCursor&&auditCursor>=range.from&&auditCursor<recentFrom?auditCursor:range.from;
    const to=[shiftDay(from,27),shiftDay(recentFrom,-1)].sort()[0];
    ranges.push({from,to});auditCursor=shiftDay(to,1);auditAt=now.toISOString();
  }
  return {ranges:mergeRanges(ranges),mode:missing.length?'backfill':'incremental',auditAt,auditCursor};
}
export async function collectCachedReviews(store,connector,platform,period,options={}) {
  const now=options.now||new Date(),range=reviewRange(period,now);
  let cache=store.data.reviewCache?.[platform];
  if(cache&&connector.status){const status=await connector.status();if(status.connected&&status.store&&status.store!==cache.store){if(options.automatic)throw new AppError('연결된 판매자 계정이 변경되었습니다.',409,'STORE_CHANGED');cache=null;}}
  const archived=(store.data.reviewArchive||[]).filter(row=>reviewPlatform(row)===platform&&row.store===cache?.store);
  const schemaChanged=Boolean(cache&&connector.cacheVersion&&cache.connectorVersion!==connector.cacheVersion);
  const full=options.full||schemaChanged;
  const map=new Map(archived.map(row=>[row.id,{...row}])),plan=planReviewRefresh(cache,platform,range,{...options,full,now});
  let storeName,shop=cache?.store,coverage=schemaChanged?[]:[...(cache?.coverage||[])],read=0,checkpoint=cache?.checkpoint,sourceTotal=cache?.sourceTotal;
  const results=connector.syncChanges
    ? [await connector.syncChanges(period,{checkpoint,sourceTotal,knownIds:new Set(archived.filter(row=>!row.sourceRemovedAt).map(row=>row.id)),full:options.full||!checkpoint,now})]
    : [];
  if(!connector.syncChanges)for(const part of plan.ranges)results.push(await connector.syncRange(part,period));
  for(const [index,result] of results.entries()) {
    const fetched=result.archiveReviews||result.reviews,part={from:isoDay(result.from),to:isoDay(result.to)};
    if(!Array.isArray(fetched)||!validRange(part)||result.reviews.length!==result.total||new Set(fetched.map(row=>row.id)).size!==fetched.length||fetched.some(row=>row.store!==result.store||!isoDay(row.date)||isoDay(row.date)<part.from||isoDay(row.date)>part.to))throw new AppError('일부 리뷰를 확인하지 못했습니다. 저장된 리뷰는 유지됩니다.',502,'INCOMPLETE_SYNC');
    if(!connector.syncChanges&&(part.from>plan.ranges[index].from||part.to<plan.ranges[index].to))throw new AppError('요청한 리뷰 조회 기간이 정확히 적용되지 않았습니다.',502,'INCOMPLETE_SYNC');
    if(shop&&shop!==result.store)throw new AppError('조회 중 판매자 계정이 변경되었습니다.',409,'STORE_CHANGED');
    shop=result.store;storeName=result.storeName||storeName;read+=fetched.length;
    if(connector.readReplies)await connector.readReplies(fetched);
    if(!result.patchOnly) {
      const ids=new Set(fetched.map(row=>row.id));
      for(const [id,row] of map)if(isoDay(row.date)>=part.from&&isoDay(row.date)<=part.to&&!ids.has(id))map.set(id,{...row,sourceRemovedAt:now.toISOString()});
    }
    coverage=mergeRanges([...coverage,part]);
    for(const row of fetched)map.set(row.id,{...map.get(row.id),...row,...(row.hasReply===false?{reply:null}:{}),platform,sourceRemovedAt:undefined,checkedAt:now.toISOString()});
    checkpoint=result.checkpoint||checkpoint;sourceTotal=result.sourceTotal??sourceTotal;
  }
  if(missingRanges(range,coverage).length)throw new AppError('선택한 기간의 리뷰를 모두 확인하지 못했습니다. 저장된 목록은 유지됩니다.',502,'INCOMPLETE_SYNC');
  const before=new Map(archived.map(row=>[row.id,row])),rows=[...map.values()];
  const added=rows.filter(row=>!row.sourceRemovedAt&&(!before.has(row.id)||before.get(row.id).sourceRemovedAt)).length;
  const replyChanged=rows.filter(row=>before.has(row.id)&&!row.sourceRemovedAt&&(row.hasReply!==before.get(row.id).hasReply||(row.reply||'')!==(before.get(row.id).reply||''))).length;
  const reviews=visibleRows(rows,platform,shop,range);
  return {reviews,total:reviews.length,store:shop,...(storeName?{storeName}:{}),period,...range,mode:plan.mode,read,added,replyChanged,
    cacheUpdate:{rows,cache:{store:shop,coverage,lastSync:now.toISOString(),auditAt:plan.auditAt,auditCursor:plan.auditCursor,checkpoint,sourceTotal,connectorVersion:connector.cacheVersion}}};
}
