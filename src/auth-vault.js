import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './core.js';

// Only ciphertext reaches disk. Secrets travel over stdin/stdout, never process arguments.
export function windowsProtect(input, decrypt = false) {
  if (process.platform !== 'win32') throw new AppError('자동 로그인 정보 저장은 Windows에서 지원합니다.', 503, 'VAULT_UNAVAILABLE');
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; try { $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result)); } catch { exit 1 }`;
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', done = false;
    const finish = error => { if (done) return; done = true; clearTimeout(timer); if (error) reject(new AppError('이 Windows 계정에서 로그인 정보를 보호하거나 읽을 수 없습니다. 다시 저장해 주세요.', 503, 'VAULT_UNAVAILABLE')); else resolve(output.trim()); };
    const timer = setTimeout(() => { child.kill(); finish(true); }, 10000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 100000) { child.kill(); finish(true); } });
    child.stdin.on('error', () => finish(true)); child.on('error', () => finish(true));
    child.on('close', code => finish(code !== 0 || !output.trim()));
    child.stdin.end(input);
  });
}

export class AuthVault {
  constructor(directory, protect = windowsProtect, { platform = 'naver' } = {}) {
    if (!['naver', 'coupang', 'ably', 'baemin', 'coupangeats'].includes(platform)) throw new Error('Unsupported credential store');
    this.file = path.join(directory, `${platform}-auth.json`); this.protect = protect;
    this.methods = platform === 'naver' ? ['naver', 'commerce'] : [platform];
    this.defaults = { version: 1, enabled: false, encrypted: null, method: this.methods[0], blocked: null };
    this.data = { ...this.defaults };
  }
  async init() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.version !== 1 || !this.methods.includes(data.method) || (data.encrypted && typeof data.encrypted !== 'string')) throw new Error('Invalid vault');
      this.data = data;
    } catch (e) { if (e.code !== 'ENOENT') this.data.blocked = 'storage_error'; }
  }
  publicState() { return { enabled: this.data.enabled === true, configured: Boolean(this.data.encrypted), method: this.data.method, blocked: this.data.blocked || null }; }
  async write(next) {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file + '.tmp', JSON.stringify(next), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file); this.data = next;
  }
  async save(input) {
    if (typeof input?.enabled !== 'boolean') throw new AppError('자동 로그인 사용 여부를 선택해 주세요.');
    if (input.username !== undefined && (typeof input.username !== 'string' || input.username.length > 200)) throw new AppError('아이디를 확인해 주세요.');
    if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 500)) throw new AppError('비밀번호를 확인해 주세요.');
    const method = input.method || this.data.method;
    if (!this.methods.includes(method)) throw new AppError('로그인 방식을 확인해 주세요.');
    let username = input.username?.trim() || '';
    const password = input.password || '';
    let next = { ...this.data, enabled: input.enabled, blocked: null };
    if (next.encrypted && method !== next.method && (!username || !password)) throw new AppError('로그인 방식을 바꾸려면 아이디와 비밀번호도 입력해 주세요.');
    if (username || password) {
      if (!password) throw new AppError('아이디를 바꾸려면 새 계정의 비밀번호도 입력해 주세요.');
      // A password-only update reuses the account inside the vault, never in the browser.
      if (!username && next.encrypted && method === next.method) username = (await this.decryptCredentials()).username;
      if (!username) throw new AppError('처음 연결할 때는 아이디와 비밀번호를 모두 입력해 주세요.');
      const payload = JSON.stringify({ username, password, method });
      next.encrypted = await this.protect(Buffer.from(payload, 'utf8').toString('base64')); next.method = method;
    }
    if (next.enabled && !next.encrypted) throw new AppError('자동 로그인에 사용할 아이디와 비밀번호를 입력해 주세요.');
    await this.write(next); return this.publicState();
  }
  async credentials() {
    if (!this.data.enabled || !this.data.encrypted) return null;
    return this.decryptCredentials();
  }
  async decryptCredentials(snapshot = this.data) {
    const data = { ...snapshot };
    const plain = await this.protect(data.encrypted, true);
    try {
      const saved = JSON.parse(Buffer.from(plain, 'base64').toString('utf8'));
      if (saved.method !== data.method || typeof saved.username !== 'string' || !saved.username.trim() || saved.username.length > 200 || typeof saved.password !== 'string' || !saved.password || saved.password.length > 500) throw new Error('Invalid credentials');
      return saved;
    } catch { throw new AppError('저장된 로그인 정보를 다시 입력해 주세요.', 503, 'VAULT_UNAVAILABLE'); }
  }
  async block(reason) { await this.write({ ...this.data, blocked: reason }); }
  async forget() { await rm(this.file, { force: true }); this.data = { ...this.defaults }; return this.publicState(); }
}
