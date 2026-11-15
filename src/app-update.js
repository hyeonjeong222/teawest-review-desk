import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './core.js';

export const releaseRepository = 'hyeonjeong222/teawest-review-desk';
export const installerName = 'ReviewDesk-Setup-x64.exe';
const manifestName = 'review-desk-update.json';
const maxInstallerSize = 160 * 1024 * 1024;
export function compareVersions(a, b) {
  const parse = v => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const left = parse(a), right = parse(b);
  if (!left || !right) throw new AppError('업데이트 버전을 확인할 수 없습니다.', 502, 'UPDATE_INVALID');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
export function releaseAssetUrl(url, tag, name) {
  return url === `https://github.com/${releaseRepository}/releases/download/${tag}/${name}`;
}
async function fetchReleaseAsset(url, options, fetcher) {
  // GitHub serves release files through a signed CDN redirect. Allow only that host.
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url, { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location) break;
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.username || next.password || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) break;
    url = next.href;
  }
  throw new AppError('GitHub 설치 파일 주소를 확인하지 못했습니다.', 502, 'UPDATE_INVALID');
}
async function jsonResponse(response, limit = 65536) {
  if (!response.ok) { await response.body?.cancel(); throw new AppError('업데이트 서버에 연결하지 못했습니다. 잠시 후 다시 확인해 주세요.', 502, 'UPDATE_NETWORK'); }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw new AppError('업데이트 정보가 올바르지 않습니다.', 502, 'UPDATE_INVALID'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('업데이트 정보를 읽지 못했습니다.', 502, 'UPDATE_INVALID'); }
}
function startInstaller(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export class AppUpdater {
  constructor(directory, version, { fetcher = fetch, launch = startInstaller } = {}) {
    Object.assign(this, { directory, version, fetcher, launch });
    this.state = { currentVersion: version, latestVersion: null, phase: 'idle', available: false, progress: 0, message: '업데이트를 확인해 주세요.' };
    this.pending = null; this.release = null;
  }
  publicState() { return { ...this.state }; }
  async check() {
    if (this.pending) return this.pending;
    this.pending = this.checkRelease().finally(() => { this.pending = null; }); return this.pending;
  }
  async checkRelease() {
    this.state.phase = 'checking'; this.state.message = '새 버전을 확인하고 있습니다.';
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${releaseRepository}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ReviewDesk-Updater', 'x-github-api-version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (response.status === 404) { await response.body?.cancel(); this.release = null; Object.assign(this.state, { phase: 'current', available: false, message: '등록된 설치 버전이 아직 없습니다.' }); return this.publicState(); }
      const release = await jsonResponse(response);
      const version = String(release.tag_name || '').replace(/^v/, '');
      if (release.draft || release.prerelease || release.tag_name !== `v${version}`) throw new AppError('정식 업데이트 정보를 확인할 수 없습니다.', 502, 'UPDATE_INVALID');
      const newer = compareVersions(version, this.version) > 0;
      if (!newer) { this.release = null; Object.assign(this.state, { latestVersion: version, available: false, phase: 'current', message: '최신 버전을 사용하고 있습니다.' }); return this.publicState(); }
      const asset = release.assets?.find(a => a.name === installerName), manifestAsset = release.assets?.find(a => a.name === manifestName);
      if (!asset || !manifestAsset || !releaseAssetUrl(asset.browser_download_url, release.tag_name, installerName) || !releaseAssetUrl(manifestAsset.browser_download_url, release.tag_name, manifestName)) throw new AppError('설치 파일이 준비되지 않은 버전입니다.', 502, 'UPDATE_INVALID');
      const manifest = await jsonResponse(await fetchReleaseAsset(manifestAsset.browser_download_url, { signal: AbortSignal.timeout(20000) }, this.fetcher), 16384);
      if (manifest.version !== version || manifest.file !== installerName || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.size) || manifest.size < 1024 || manifest.size > maxInstallerSize || manifest.size !== asset.size || (asset.digest && asset.digest !== `sha256:${manifest.sha256}`)) throw new AppError('설치 파일 검증 정보를 확인할 수 없습니다.', 502, 'UPDATE_INVALID');
      this.release = { ...manifest, url: asset.browser_download_url };
      Object.assign(this.state, { latestVersion: version, available: true, phase: 'available', progress: 0, message: `새 버전 ${version}을 설치할 수 있습니다.` });
      return this.publicState();
    } catch (error) {
      this.release = null; Object.assign(this.state, { phase: 'error', available: false, message: error instanceof AppError ? error.message : '업데이트 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' });
      return this.publicState();
    }
  }
  async install(confirmed) {
    if (confirmed !== true) throw new AppError('업데이트 설치를 확인해 주세요.', 400, 'UPDATE_CONFIRM');
    if (this.pending || this.state.phase === 'installing') throw new AppError('업데이트를 처리하고 있습니다.', 409, 'UPDATE_BUSY');
    if (!this.release || !this.state.available) throw new AppError('먼저 업데이트를 확인해 주세요.', 409, 'UPDATE_NOT_READY');
    this.pending = this.downloadAndLaunch().finally(() => { this.pending = null; }); return this.pending;
  }
  async downloadAndLaunch() {
    const release = { ...this.release }, folder = path.join(this.directory, 'updates');
    const file = path.join(folder, `ReviewDesk-Setup-${release.version}.exe`), temp = file + '.download';
    let handle;
    try {
      await mkdir(folder, { recursive: true });
      Object.assign(this.state, { phase: 'downloading', progress: 0, message: '설치 파일을 내려받고 있습니다.' });
      const response = await fetchReleaseAsset(release.url, { signal: AbortSignal.timeout(300000) }, this.fetcher);
      if (!response.ok) throw new AppError('설치 파일 다운로드에 실패했습니다.', 502, 'UPDATE_NETWORK');
      handle = await open(temp, 'w'); const hash = createHash('sha256'); let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length; if (size > release.size) throw new AppError('설치 파일 크기가 일치하지 않습니다.', 502, 'UPDATE_INVALID');
        hash.update(chunk); await handle.writeFile(chunk); this.state.progress = Math.floor(size / release.size * 100);
      }
      await handle.close(); handle = null;
      if (size !== release.size || hash.digest('hex') !== release.sha256) throw new AppError('설치 파일 검증에 실패했습니다. 다시 내려받아 주세요.', 502, 'UPDATE_INVALID');
      await rename(temp, file); await this.launch(file);
      Object.assign(this.state, { phase: 'installing', message: '설치 창에서 업데이트를 완료해 주세요. 저장한 API 키와 로그인 정보는 유지됩니다.' });
    } catch (error) {
      Object.assign(this.state, { phase: 'error', message: error instanceof AppError ? error.message : '설치 파일을 실행하지 못했습니다. GitHub에서 설치 파일을 받아 실행해 주세요.' });
    } finally { await handle?.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); }
    return this.publicState();
  }
}
