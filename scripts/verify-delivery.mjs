import { NaverConnector } from '../src/naver.js';
import { BaeminConnector } from '../src/baemin.js';
import { EatsConnector } from '../src/eats.js';
const host=new NaverConnector('.local');
try {
 const platform=process.argv[2]||'baemin-teawest';const c=platform.startsWith('baemin-')?new BaeminConnector(host,platform):new EatsConnector(host,platform);
 const result=await c.sync('1m');
 console.log(JSON.stringify({total:result.total,store:result.store,from:result.from,to:result.to,replied:result.reviews.filter(r=>r.hasReply).length}));
 if(process.argv.includes('--fill')){
   const r=result.reviews.find(r=>!r.hasReply&&r.replyAllowed);
   if(r){const {card,form,editor}=await c.fill(r,'연동 확인용 임시 문구입니다. 등록하지 않습니다.');console.log('Input verified:',await editor.inputValue()==='연동 확인용 임시 문구입니다. 등록하지 않습니다.');await editor.fill('');await (form||card).getByRole('button',{name:'취소',exact:true}).click();}
 }
}finally{await host.browser?.close();}
