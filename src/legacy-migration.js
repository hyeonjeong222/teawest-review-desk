import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { AuthVault } from './auth-vault.js';
import { APIKeyVault } from './api-key-vault.js';

const providers = ['naver', 'coupang', 'ably', 'baemin', 'coupangeats'];
export const persistentFiles = ['state.json', ...providers.map(p => `${p}-auth.json`), 'openai-key.json'];
async function exists(file) { try { await access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
export async function migrateLegacyData(sourceRoot, target, { verify = true } = {}) {
  sourceRoot = path.resolve(sourceRoot); target = path.resolve(target);
  const source = path.join(sourceRoot, '.local');
  if (source.toLowerCase() === target.toLowerCase()) throw new Error('이전 폴더와 새 저장 폴더가 같습니다.');
  const pkg = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'teawest-review-desk') throw new Error('기존 리뷰 관리 프로그램 폴더를 선택해 주세요.');
  const targetEntries = await readdir(target).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  if (targetEntries.some(name => persistentFiles.includes(name))) return { migrated: false, reason: 'already_initialized' };
  if (targetEntries.length) throw new Error('새 저장 폴더에 파일이 있어 자동 이전을 중지했습니다. 기존 파일은 유지됩니다.');
  if (await exists(path.join(source, 'credential-transfer-pending.json'))) throw new Error('기존 앱에서 진행 중이던 로그인 이전을 먼저 완료해 주세요.');
  const selected = [];
  for (const name of persistentFiles) {
    const file = path.join(source, name);
    if (!await exists(file)) continue;
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 100 * 1024 * 1024) throw new Error('기존 저장 파일의 형식을 확인할 수 없습니다.');
    JSON.parse(await readFile(file, 'utf8'));
    selected.push(name);
  }
  if (!selected.length) throw new Error('선택한 폴더에 기존 리뷰 앱의 저장 정보가 없습니다.');
  if (verify) {
    for (const provider of providers) {
      if (!selected.includes(`${provider}-auth.json`)) continue;
      const vault = new AuthVault(source, undefined, { platform: provider }); await vault.init();
      if (vault.publicState().blocked === 'storage_error') throw new Error('기존 로그인 정보를 읽을 수 없습니다.');
      if (vault.publicState().configured) await vault.decryptCredentials();
    }
    if (selected.includes('openai-key.json')) {
      const ai = { configured: false, configure() { this.configured = true; } };
      const vault = new APIKeyVault(source, ai); await vault.init();
      if (vault.publicState().storageError) throw new Error('이 Windows 계정에서 기존 API 키를 읽을 수 없습니다. 기존 앱에서 암호화된 이전 파일을 만들어 복원해 주세요.');
    }
  }
  const parent = path.dirname(target); await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, '.review-migration-'));
  try {
    for (const name of selected) await copyFile(path.join(source, name), path.join(stage, name));
    // Only remove an empty destination. Any concurrent initialization fails safely.
    if (await exists(target)) await rmdir(target);
    await rename(stage, target);
    return { migrated: true, files: selected.length };
  } finally {
    const resolved = path.resolve(stage);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('.review-migration-')) throw new Error('Unexpected migration staging path');
    await rm(resolved, { recursive: true, force: true });
  }
}
