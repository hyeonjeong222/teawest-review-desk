import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { windowsProtect } from './auth-vault.js';
import { validateApiKey } from './ai.js';
import { AppError } from './core.js';

// Plaintext lives only in memory. The file and atomic-write temporary contain DPAPI ciphertext.
export class APIKeyVault {
  constructor(directory, ai, protect = windowsProtect) {
    this.file = path.join(directory, 'openai-key.json'); this.ai = ai; this.protect = protect;
    this.saved = false; this.storageError = false; this.source = ai.configured ? 'environment' : 'none';
  }
  publicState() { return { saved: this.saved, storageError: this.storageError, source: this.source }; }
  async init() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.version !== 1) throw new Error('Invalid key vault');
      if (data.disabled === true) { this.ai.key = ''; this.source = 'none'; return; }
      this.saved = true;
      if (typeof data.encrypted !== 'string' || !data.encrypted) throw new Error('Missing ciphertext');
      const plain = await this.protect(data.encrypted, true);
      const key = validateApiKey(Buffer.from(plain, 'base64').toString('utf8'));
      this.ai.configure(key); this.source = 'saved';
    } catch (e) {
      if (e.code === 'ENOENT') return;
      this.ai.key = ''; this.saved = true; this.storageError = true; this.source = 'none';
    }
  }
  async write(data) {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file + '.tmp', JSON.stringify(data), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
  }
  async save(input) {
    const key = validateApiKey(input);
    try {
      const encrypted = await this.protect(Buffer.from(key, 'utf8').toString('base64'));
      await this.write({ version: 1, encrypted, disabled: false });
    } catch { throw new AppError('API 키를 암호화해 저장하지 못했습니다. 기존 키는 유지됩니다. 다시 시도해 주세요.', 503, 'API_KEY_STORAGE'); }
    this.ai.configure(key); this.saved = true; this.storageError = false; this.source = 'saved';
    return this.publicState();
  }
  async forget() {
    try {
      // A non-secret disabled marker also prevents an old environment key reappearing on restart.
      await this.write({ version: 1, encrypted: null, disabled: true });
    } catch { throw new AppError('저장된 API 키를 삭제하지 못했습니다. 다시 시도해 주세요.', 503, 'API_KEY_STORAGE'); }
    this.ai.key = ''; this.saved = false; this.storageError = false; this.source = 'none';
    return this.publicState();
  }
}
