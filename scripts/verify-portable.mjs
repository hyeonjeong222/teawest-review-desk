import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

const folder=path.resolve(process.argv[2]), port=14319, base=`http://127.0.0.1:${port}`;
for(const name of ['.local','.env','.git'])await assert.rejects(access(path.join(folder,name)));
const manifest=(await readFile(path.join(folder,'SHA256SUMS.txt'),'utf8')).trim().split('\n');
for(const line of manifest){const [hash,file]=line.split('  ');assert.equal(createHash('sha256').update(await readFile(path.join(folder,file))).digest('hex'),hash,file);}
const child=spawn(path.join(folder,'runtime','node.exe'),['--env-file-if-exists=.env','src/server.js'],{cwd:folder,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),NAVER_CDP_URL:'http://127.0.0.1:19339',OPENAI_API_KEY:'',NODE_OPTIONS:''}});
let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
try{
  let session;
  for(let i=0;i<60;i++){try{session=await fetch(base+'/api/session',{signal:AbortSignal.timeout(1000)}).then(r=>r.json());break;}catch{await new Promise(r=>setTimeout(r,250));}}
  assert.ok(session?.csrf,output);assert.equal(session.aiConfigured,false);
  const reviews=await fetch(base+'/api/reviews').then(r=>r.json());assert.deepEqual(reviews.reviews,[]);assert.deepEqual(reviews.drafts,{});
  const html=await fetch(base).then(r=>r.text());assert.match(html,/리뷰 관리/);
  const status=await fetch(base+'/api/status').then(r=>r.json());
  for(const value of Object.values(status.platforms)){assert.equal(value.connected,false);assert.equal(value.autoLogin.configured,false);}
  const crossOrigin=await fetch(base+'/api/auto-sync/settings',{method:'POST',headers:{origin:'https://example.invalid','content-type':'application/json','x-review-token':session.csrf},body:'{"enabled":false}'});assert.equal(crossOrigin.status,403);
  const emptyExport=await fetch(base+'/api/credentials/export',{method:'POST',headers:{origin:base,'content-type':'application/json','x-review-token':session.csrf},body:JSON.stringify({password:'synthetic-smoke-password'})});assert.equal(emptyExport.status,409);assert.equal((await emptyExport.json()).code,'TRANSFER_EMPTY');
  await access(path.join(folder,'Check Connection.cmd'));
  const diagnostic = await promisify(execFile)(path.join(folder,'runtime','node.exe'),['scripts/diagnose-connection.mjs'],{cwd:folder,windowsHide:true,timeout:30000,env:{...process.env,PORT:String(port),NAVER_CDP_URL:'http://127.0.0.1:19339',NODE_OPTIONS:''}});
  assert.match(diagnostic.stdout,/review-desk-connection-diagnostic/);
  const reports=(await readdir(path.join(folder,'.local'))).filter(name=>/^connection-diagnostic-.*\.txt$/.test(name));
  assert.equal(reports.length,1);
  const report=await readFile(path.join(folder,'.local',reports[0]),'utf8');
  assert.match(report,/"recognized": true/);assert.equal(report.includes(session.csrf),false);
  console.log(JSON.stringify({packagedRuntime:true,hashesVerified:manifest.length,cleanReviews:true,credentialsAbsent:true,gptKeyAbsent:true,localServerStarted:true,csrfVerified:true,diagnosticReportVerified:true}));
}finally{child.kill();}
