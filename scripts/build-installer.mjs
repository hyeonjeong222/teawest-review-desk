import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64.');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Use a stable semantic version.');
const build = path.join(root, '.local', 'installer-build'); await mkdir(build, { recursive: true });
const output = path.join(root, 'dist', `installer-${pkg.version}`); await mkdir(output, { recursive: true });
const icon = path.join(build, 'ReviewDesk.ico');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'installer', 'build-icon.ps1'), '-OutputPath', icon], { windowsHide: true, timeout: 30000 });
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const compile = args => execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', `/win32manifest:${path.join(root, 'installer', 'app.manifest')}`, `/win32icon:${icon}`, ...args], { cwd: root, windowsHide: true, timeout: 60000, stdio: 'pipe' });
try {
  compile([`/out:${path.join(build, 'ReviewDesk.exe')}`, path.join(root, 'installer', 'Launcher.cs')]);
  let packaged;
  if (process.argv.includes('--recompile-shell')) {
    // Native UI-only iteration: never silently reuse this for a normal release build.
    const previous = await readFile(path.join(build, 'BuildInfo.cs'), 'utf8');
    const prefix = previous.match(/PayloadPrefix = "(ReviewDesk-Windows-x64-[\dTZ-]+)"/)?.[1];
    const hash = previous.match(/PayloadHash = "([a-f0-9]{64})"/)?.[1];
    if (!prefix || !hash || !previous.includes(`Version = "${pkg.version}"`)) throw new Error('No matching previous payload.');
    packaged = { directory: path.join(root, 'dist', prefix), zip: path.join(root, 'dist', prefix + '.zip') };
    if (createHash('sha256').update(await readFile(packaged.zip)).digest('hex') !== hash) throw new Error('Previous payload changed.');
  } else {
    console.log('Preparing verified application payload…');
    packaged = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts', 'package-portable.mjs')], { cwd: root, windowsHide: true, timeout: 300000, encoding: 'utf8' }).trim());
  }
  const payload = await readFile(packaged.zip), payloadHash = createHash('sha256').update(payload).digest('hex');
  const info = `internal static class BuildInfo { internal const string Version = "${pkg.version}"; internal const string PayloadHash = "${payloadHash}"; internal const string PayloadPrefix = "${path.basename(packaged.directory)}"; }`;
  await writeFile(path.join(build, 'BuildInfo.cs'), info);
  const file = 'ReviewDesk-Setup-x64.exe', installer = path.join(output, file);
  compile([`/out:${installer}`, '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', '/reference:System.Management.dll', `/resource:${packaged.zip},ReviewDesk.Payload.zip`, `/resource:${path.join(build, 'ReviewDesk.exe')},ReviewDesk.Launcher.exe`, path.join(root, 'installer', 'Installer.cs'), path.join(build, 'BuildInfo.cs')]);
  const bytes = await readFile(installer);
  const manifest = { version: pkg.version, file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(path.join(output, 'review-desk-update.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(output, 'SHA256SUMS.txt'), `${manifest.sha256}  ${file}\n`);
  console.log(JSON.stringify({ directory: output, installer, payloadDirectory: packaged.directory, ...manifest }));
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw new Error('Windows installer build failed. See the compiler or packaging output above.');
}
