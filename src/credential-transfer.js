import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './core.js';
import { validateApiKey } from './ai.js';

const derive = promisify(scrypt), format = 'review-desk-login-backup', aad = Buffer.from(`${format}:1`);
const providers = ['naver','coupang','ably','baemin','coupangeats'];
const files = [...providers.map(p=>`${p}-auth.json`),'openai-key.json'];
const journalName = 'credential-transfer-pending.json';
export const backupLimit = 24576;
const invalid = () => new AppError('이전 파일의 암호가 다르거나 파일이 손상되었습니다. 기존 정보는 유지됩니다.',400,'TRANSFER_INVALID');
function passwordValue(password) {
  if(typeof password!=='string' || password.length<10 || password.length>128 || !password.trim()) throw new AppError('이전용 암호는 10~128자로 입력해 주세요.',400,'TRANSFER_PASSWORD');
  return password;
}
function decode(value, length) {
  if(typeof value!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw invalid();
  const bytes=Buffer.from(value,'base64');
  if(bytes.toString('base64')!==value || (length && bytes.length!==length))throw invalid();
  return bytes;
}
async function keyFor(password,salt) {return derive(passwordValue(password),salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
export async function encryptLoginBackup(payload,password) {
  const salt=randomBytes(16),iv=randomBytes(12),key=await keyFor(password,salt),plain=Buffer.from(JSON.stringify(payload));
  try{
    if(plain.length>16384)throw new AppError('이전할 로그인 정보가 너무 큽니다.');
    const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
    const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
    return {format,version:1,kdf:'scrypt-32768-8-1',cipher:'aes-256-gcm',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  }finally{key.fill(0);plain.fill(0);}
}
export async function decryptLoginBackup(backup,password) {
  passwordValue(password);
  if(!backup || JSON.stringify(backup).length>backupLimit || backup.format!==format || backup.version!==1 || backup.kdf!=='scrypt-32768-8-1' || backup.cipher!=='aes-256-gcm')throw invalid();
  const salt=decode(backup.salt,16),iv=decode(backup.iv,12),tag=decode(backup.tag,16),ciphertext=decode(backup.ciphertext);
  if(ciphertext.length>16384)throw invalid();
  const key=await keyFor(password,salt);let plain;
  try{
    const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(aad);decipher.setAuthTag(tag);
    plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
    return validatePayload(JSON.parse(plain.toString('utf8')));
  }catch{throw invalid();}finally{key.fill(0);plain?.fill(0);}
}
function validatePayload(input) {
  if(!input || input.version!==1 || !input.accounts || Array.isArray(input.accounts) || typeof input.accounts!=='object' || Object.keys(input.accounts).some(p=>!providers.includes(p)))throw invalid();
  const accounts={};
  for(const [provider,value] of Object.entries(input.accounts)) {
    const methods=provider==='naver'?['naver','commerce']:[provider];
    if(!value || typeof value.enabled!=='boolean' || !methods.includes(value.method) || typeof value.username!=='string' || !value.username.trim() || value.username.length>200 || typeof value.password!=='string' || !value.password || value.password.length>500)throw invalid();
    accounts[provider]={enabled:value.enabled,method:value.method,username:value.username,password:value.password};
  }
  const apiKey=input.apiKey===null?null:validateApiKey(input.apiKey);
  if(!Object.keys(accounts).length && !apiKey)throw invalid();
  return {version:1,accounts,apiKey};
}
async function atomicFile(file,content) {await writeFile(file+'.transfer.tmp',content,{mode:0o600});await rename(file+'.transfer.tmp',file);}
// This journal contains only local DPAPI ciphertext. An interrupted import rolls back at startup.
export async function recoverCredentialTransfer(directory) {
  const journal=path.join(directory,journalName);let saved;
  try{saved=JSON.parse(await readFile(journal,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw new Error('로그인 정보 이전 복구 파일을 읽지 못했습니다.');}
  if(saved.version!==1 || !Array.isArray(saved.entries) || saved.entries.length>files.length || saved.entries.some(e=>!files.includes(e.file)||!(e.before===null||typeof e.before==='string')) || new Set(saved.entries.map(e=>e.file)).size!==saved.entries.length)throw new Error('로그인 정보 이전 복구 파일을 확인해 주세요.');
  for(const entry of saved.entries){const target=path.join(directory,entry.file);if(entry.before===null)await rm(target,{force:true});else await atomicFile(target,entry.before);}
  await rm(journal);
}
export async function commitCredentialTransfer(directory,replacements,{write=atomicFile}={}) {
  await mkdir(directory,{recursive:true});
  const entries=[];
  for(const file of Object.keys(replacements)) {
    if(!files.includes(file))throw new Error('Unexpected credential file');
    let before=null;try{before=await readFile(path.join(directory,file),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
    entries.push({file,before});
  }
  const journal=path.join(directory,journalName);
  await atomicFile(journal,JSON.stringify({version:1,entries}));
  try{for(const [file,value] of Object.entries(replacements))await write(path.join(directory,file),JSON.stringify(value));await rm(journal);}
  catch{await recoverCredentialTransfer(directory);throw new AppError('로그인 정보를 저장하지 못해 이전 상태로 되돌렸습니다. 다시 시도해 주세요.',503,'TRANSFER_STORAGE');}
}
export class CredentialTransfer {
  constructor({directory,auths,keyVault,ai,settingsQueue}) {Object.assign(this,{directory,auths,keyVault,ai,settingsQueue});}
  async export(password) {
    passwordValue(password);const accounts={};let apiKey=null;
    for(const [provider,auth] of Object.entries(this.auths)) {
      // Read a complete saved version without waiting behind a long review collection.
      // Vault writes replace data only after their atomic file rename completes.
      const snapshot={...auth.vault.data};
      if(snapshot.blocked==='storage_error')throw new AppError('읽을 수 없는 로그인 정보가 있습니다. 해당 서비스의 연결 설정을 다시 저장해 주세요.',409,'TRANSFER_SOURCE');
      if(snapshot.encrypted)accounts[provider]={...await auth.vault.decryptCredentials(snapshot),enabled:snapshot.enabled===true};
    }
    await this.settingsQueue.run(async()=>{
      if(this.keyVault.publicState().storageError)throw new AppError('저장된 GPT 키를 읽을 수 없습니다. GPT 설정에서 다시 저장해 주세요.',409,'TRANSFER_SOURCE');
      if(this.ai.configured)apiKey=validateApiKey(this.ai.key);
    });
    if(!Object.keys(accounts).length && !apiKey)throw new AppError('옮길 로그인 정보나 GPT 키가 없습니다. 먼저 연결 설정을 저장해 주세요.',409,'TRANSFER_EMPTY');
    const backup=await encryptLoginBackup({version:1,accounts,apiKey},password);
    return {backup,providers:Object.keys(accounts),includesGPT:Boolean(apiKey)};
  }
  async restore(backup,password,confirmed) {
    if(confirmed!==true)throw new AppError('현재 PC의 로그인 설정을 바꾸는 데 동의해 주세요.',400,'TRANSFER_CONFIRM');
    const payload=await decryptLoginBackup(backup,password);
    // Hold each distinct provider queue plus settings while replacing their credential files.
    const queues=[...new Set([...Object.values(this.auths).map(a=>a.queue),this.settingsQueue])];
    const lock=index=>index<queues.length?queues[index].run(()=>lock(index+1)):this.apply(payload);
    return lock(0);
  }
  async apply(payload) {
    const replacements={},prepared={};
    // Complete validation and all local encryption before touching existing files.
    for(const [provider,value] of Object.entries(payload.accounts)) {
      const vault=this.auths[provider].vault;
      const plain=Buffer.from(JSON.stringify({username:value.username,password:value.password,method:value.method}));
      let encrypted;try{encrypted=await vault.protect(plain.toString('base64'));}finally{plain.fill(0);}
      prepared[provider]={...vault.defaults,enabled:value.enabled,method:value.method,encrypted,blocked:null};
      replacements[`${provider}-auth.json`]=prepared[provider];
    }
    if(payload.apiKey){const plain=Buffer.from(payload.apiKey);try{replacements['openai-key.json']={version:1,disabled:false,encrypted:await this.keyVault.protect(plain.toString('base64'))};}finally{plain.fill(0);}}
    await commitCredentialTransfer(this.directory,replacements);
    for(const [provider,data] of Object.entries(prepared)){const auth=this.auths[provider];auth.vault.data=data;auth.phase=data.enabled?'idle':'disabled';auth.lastAttempt=0;}
    if(payload.apiKey){this.ai.configure(payload.apiKey);this.keyVault.saved=true;this.keyVault.storageError=false;this.keyVault.source='saved';}
    return {providers:Object.keys(prepared),includesGPT:Boolean(payload.apiKey)};
  }
}
