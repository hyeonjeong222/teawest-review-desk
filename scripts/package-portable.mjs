import { cp, mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this Windows x64 package with Windows x64 Node.js.');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.join(root, 'dist', `ReviewDesk-Windows-x64-${stamp}`);
await mkdir(directory, { recursive: true });
// Deliberate allowlist: no local state, credentials, .env, browser profile, Git, or diagnostic scripts.
for (const item of ['src', 'public', 'package.json', 'package-lock.json', 'README.md', '다른 PC 사용 안내.txt', '리뷰관리 실행.cmd', 'start-review.ps1', 'scripts/launch.mjs']) {
  await cp(path.join(root, item), path.join(directory, item), { recursive: true, dereference: false, errorOnExist: true, force: false });
}
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
for (const [relative, info] of Object.entries(lock.packages)) {
  if (!relative) continue;
  if (!/^node_modules\/(?:@[\w-]+\/)?[\w.-]+$/.test(relative) || !info.resolved?.startsWith('https://registry.npmjs.org/')) throw new Error('Unexpected dependency in lockfile.');
  const installed = JSON.parse(await readFile(path.join(root, relative, 'package.json'), 'utf8'));
  if (installed.version !== info.version) throw new Error('Run npm ci before packaging: dependency differs from lockfile.');
  await cp(path.join(root, relative), path.join(directory, relative), { recursive: true, dereference: false });
}
await mkdir(path.join(directory, 'runtime'));
await cp(process.execPath, path.join(directory, 'runtime', 'node.exe'));
const release = `https://nodejs.org/dist/${process.version}/`;
const sumsResponse = await fetch(release+'SHASUMS256.txt',{signal:AbortSignal.timeout(30000)});
if(!sumsResponse.ok)throw new Error('Cannot verify the bundled Node.js runtime.');
const sums = await sumsResponse.text(), expected = sums.split('\n').find(line=>line.endsWith('  win-x64/node.exe'))?.split(/\s+/)[0];
const actual = createHash('sha256').update(await readFile(process.execPath)).digest('hex');
if(!expected || actual!==expected)throw new Error('Node.js runtime does not match the official Windows x64 release.');
const licenseResponse = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,{signal:AbortSignal.timeout(30000)});
if(!licenseResponse.ok)throw new Error('Cannot obtain the Node.js distribution license.');
const license = await licenseResponse.text();
if(!license.includes('Node.js') || !license.includes('Permission is hereby granted'))throw new Error('Unexpected Node.js license response.');
await writeFile(path.join(directory, 'runtime', 'NODE-LICENSE.txt'), license);
// Also provide an ASCII filename for older ZIP extractors.
await cp(path.join(directory, '리뷰관리 실행.cmd'), path.join(directory, 'Start Review Desk.cmd'));
const hashes = [];
async function audit(folder) {
  for (const entry of await readdir(folder, {withFileTypes:true})) {
    const file = path.join(folder, entry.name), relative = path.relative(directory, file).replaceAll('\\','/');
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Package contains a link: ${relative}`);
    if (entry.isDirectory()) await audit(file);
    else hashes.push(`${createHash('sha256').update(await readFile(file)).digest('hex')}  ${relative}`);
  }
}
await audit(directory);
await writeFile(path.join(directory, 'SHA256SUMS.txt'), hashes.sort().join('\n')+'\n');
await writeFile(path.join(directory, 'BUILD.json'), JSON.stringify({app:'Review Desk',builtAt:new Date().toISOString(),node:process.version,platform:'windows-x64',files:hashes.length,includesCredentials:false,includesReviewData:false},null,2));
// Pass paths via environment, not interpolated PowerShell source.
execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', 'Compress-Archive -LiteralPath $env:REVIEW_PACKAGE_FOLDER -DestinationPath $env:REVIEW_PACKAGE_ZIP -CompressionLevel Optimal'], {
  windowsHide:true, env:{...process.env,REVIEW_PACKAGE_FOLDER:directory,REVIEW_PACKAGE_ZIP:directory+'.zip'}, timeout:180000,
});
console.log(JSON.stringify({directory,zip:directory+'.zip',files:hashes.length,node:process.version}));
