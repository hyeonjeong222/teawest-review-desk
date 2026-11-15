import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server.js';
import { AuthVault } from '../src/auth-vault.js';
import { APIKeyVault } from '../src/api-key-vault.js';
import { ReplyAI } from '../src/ai.js';
import { encryptLoginBackup, decryptLoginBackup, commitCredentialTransfer, recoverCredentialTransfer } from '../src/credential-transfer.js';
import { cleanupTestDirectory } from './cleanup.js';

const password='test-only-transfer-passphrase';
const payload={version:1,accounts:{naver:{enabled:true,method:'commerce',username:'synthetic-account',password:'synthetic-password'}},apiKey:'sk-synthetic-transfer-key'};
function isolatedProtector() {
  const key=randomBytes(32);
  return async (input,decrypt=false)=>{
    if(decrypt){const b=Buffer.from(input,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('base64');}
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update(Buffer.from(input,'base64')),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64');
  };
}
test('portable backup authenticates its contents, rejects wrong passwords and oversized parameters, and contains no plaintext credentials',async()=>{
  const a=await encryptLoginBackup(payload,password),b=await encryptLoginBackup(payload,password);
  assert.notEqual(a.ciphertext,b.ciphertext);assert.deepEqual(await decryptLoginBackup(a,password),payload);
  for(const secret of ['synthetic-account','synthetic-password',payload.apiKey,password])assert.ok(!JSON.stringify(a).includes(secret));
  await assert.rejects(decryptLoginBackup(a,'different-password'),e=>e.code==='TRANSFER_INVALID');
  await assert.rejects(decryptLoginBackup({...a,tag:randomBytes(16).toString('base64')},password),e=>e.code==='TRANSFER_INVALID');
  await assert.rejects(decryptLoginBackup({...a,kdf:'scrypt-999999999'},password),e=>e.code==='TRANSFER_INVALID');
  await assert.rejects(decryptLoginBackup({...a,ciphertext:'A'.repeat(30000)},password),e=>e.code==='TRANSFER_INVALID');
  await assert.rejects(encryptLoginBackup(payload,'short'),e=>e.code==='TRANSFER_PASSWORD');
  const unknown=await encryptLoginBackup({...payload,accounts:{...payload.accounts,unexpected:payload.accounts.naver}},password);await assert.rejects(decryptLoginBackup(unknown,password));
});
test('credential import rolls back write failures and recovers an interrupted commit without touching review data',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'review-http-test-'));t.after(()=>cleanupTestDirectory(directory));
  const before=JSON.stringify({encrypted:'old-local-ciphertext'}),reviews='{"reviews":["preserve-me"]}';
  await writeFile(path.join(directory,'naver-auth.json'),before);await writeFile(path.join(directory,'state.json'),reviews);
  let writes=0;
  await assert.rejects(commitCredentialTransfer(directory,{'naver-auth.json':{encrypted:'new-local-ciphertext'},'openai-key.json':{encrypted:'new-key-ciphertext'}},{write:async(file,data)=>{if(++writes===2)throw new Error('disk failure');await writeFile(file,data);}}),e=>e.code==='TRANSFER_STORAGE');
  assert.equal(await readFile(path.join(directory,'naver-auth.json'),'utf8'),before);assert.equal(await readFile(path.join(directory,'state.json'),'utf8'),reviews);assert.ok(!(await readdir(directory)).includes('openai-key.json'));
  await writeFile(path.join(directory,'credential-transfer-pending.json'),JSON.stringify({version:1,entries:[{file:'naver-auth.json',before},{file:'openai-key.json',before:null}]}));
  await writeFile(path.join(directory,'naver-auth.json'),'partial-new');await writeFile(path.join(directory,'openai-key.json'),'partial-key');
  await recoverCredentialTransfer(directory);assert.equal(await readFile(path.join(directory,'naver-auth.json'),'utf8'),before);assert.deepEqual((await readdir(directory)).sort(),['naver-auth.json','state.json']);
});
test('HTTP transfer moves all five accounts to another local protection key, survives restart, preserves missing accounts, and enforces CSRF and confirmation',async t=>{
  const providers=['naver','coupang','ably','baemin','coupangeats'];
  async function app(port) {
    const directory=await mkdtemp(path.join(os.tmpdir(),'review-http-test-')),protect=isolatedProtector(),ai=new ReplyAI('');
    const vaults=Object.fromEntries(providers.map(platform=>[platform,new AuthVault(directory,protect,{platform})]));
    const keyVault=new APIKeyVault(directory,ai,protect),offline={status:async()=>({connected:false,networkError:true}),publish:()=>assert.fail('Transfer cannot publish'),login:()=>assert.fail('Offline connector cannot log in')};
    const result=await createApp({directory,port,maintenanceInterval:0,ai,keyVault,vault:vaults.naver,coupangVault:vaults.coupang,ablyVault:vaults.ably,deliveryVaults:vaults,connector:offline,coupangConnector:offline,ablyConnector:offline,deliveryAccountConnectors:{baemin:offline,coupangeats:offline}});
    result.server.listen(port,'127.0.0.1');await once(result.server,'listening');
    t.after(async()=>{result.server.closeAllConnections();await new Promise(r=>result.server.close(r));await cleanupTestDirectory(directory);});
    const base=`http://127.0.0.1:${port}`,post=(route,data,{origin=base,token=result.csrf}={})=>fetch(base+route,{method:'POST',headers:{origin,'x-review-token':token,'content-type':'application/json'},body:JSON.stringify(data)});
    return {...result,directory,protect,ai,vaults,keyVault,base,post};
  }
  const source=await app(14691),target=await app(14692);
  for(const p of providers)await source.vaults[p].save({enabled:p!=='ably',method:p==='naver'?'commerce':p,username:`synthetic-${p}`,password:`password-${p}`});
  await source.keyVault.save(payload.apiKey);await target.vaults.naver.save({enabled:false,username:'old-account',password:'old-password'});
  const exported=await source.post('/api/credentials/export',{password}).then(r=>r.json());assert.deepEqual(exported.providers,providers);assert.equal(exported.includesGPT,true);
  let resumeReview;const slowReview=source.service.queue.run(()=>new Promise(resolve=>{resumeReview=resolve;}));await new Promise(resolve=>setImmediate(resolve));
  try{const parallel=await Promise.race([source.post('/api/credentials/export',{password}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Export waited for review collection')),5000);timer.unref();})]);assert.equal(parallel.status,200);}finally{resumeReview();await slowReview;}
  assert.equal((await fetch(source.base+'/api/credentials/export')).status,404);
  for(const options of [{token:'wrong'},{origin:'https://example.invalid'}])assert.equal((await source.post('/api/credentials/export',{password},options)).status,403);
  const incoming={backup:exported.backup,password,confirmed:true};
  assert.equal((await target.post('/api/credentials/import',{...incoming,confirmed:false})).status,400);
  assert.equal((await target.post('/api/credentials/import',{...incoming,password:'incorrect-password'})).status,400);assert.equal((await target.vaults.naver.decryptCredentials()).username,'old-account');
  const response=await target.post('/api/credentials/import',incoming);assert.equal(response.status,200);const result=await response.json();assert.equal(result.aiConfigured,true);
  assert.ok(!JSON.stringify(result).includes(payload.apiKey));
  for(const p of providers){const reloaded=new AuthVault(target.directory,target.protect,{platform:p});await reloaded.init();assert.equal((await reloaded.decryptCredentials()).username,`synthetic-${p}`);assert.equal(reloaded.publicState().enabled,p!=='ably');assert.notEqual(reloaded.data.encrypted,source.vaults[p].data.encrypted);await assert.rejects(source.protect(reloaded.data.encrypted,true));}
  const reloadedAI=new ReplyAI(''),reloadedKey=new APIKeyVault(target.directory,reloadedAI,target.protect);await reloadedKey.init();assert.equal(reloadedAI.key,payload.apiKey);
  for(const file of await readdir(target.directory)){const text=await readFile(path.join(target.directory,file),'utf8');assert.ok(!text.includes('password-naver'));assert.ok(!text.includes(payload.apiKey));}
  const partial=await encryptLoginBackup({version:1,accounts:{},apiKey:'sk-only-new-key'},password);
  assert.equal((await target.post('/api/credentials/import',{backup:partial,password,confirmed:true})).status,200);assert.equal((await target.vaults.naver.decryptCredentials()).username,'synthetic-naver');
  for(const route of ['/api/session','/api/status','/api/reviews']){const text=await fetch(target.base+route).then(r=>r.text());assert.ok(!text.includes('synthetic-naver'));assert.ok(!text.includes('sk-only-new-key'));}
});
