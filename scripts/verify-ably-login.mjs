import {NaverConnector} from '../src/naver.js';
import {AblyConnector} from '../src/ably.js';
import {AuthVault} from '../src/auth-vault.js';
const vault=new AuthVault('.local',undefined,{platform:'ably'});await vault.init();
if(!vault.publicState().enabled||!vault.publicState().configured)throw new Error('Save Ably auto-login settings first');
const host=new NaverConnector('.local'),browser=await host.connect();
const context=await browser.newContext({serviceWorkers:'block'});
let credentials;
try{
 const scopedHost={connect:async()=>({contexts:()=>[context]})};
 const connector=new AblyConnector('.local',scopedHost);
 credentials=await vault.credentials();
 const result=await connector.login(credentials);credentials=null;
 if(!result.connected){console.log(JSON.stringify({connected:false,reason:result.reason,existingSessionPreserved:true}));process.exitCode=2;}
 else{const data=await connector.fetchPage(await connector.workspace(),1);console.log(JSON.stringify({connected:true,reviewCount:data.total_count,firstPageCount:data.reviews.length,existingSessionPreserved:true}));}
}finally{credentials=null;await context.close();await browser.close();}
