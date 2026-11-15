import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { AppUpdater, compareVersions, installerName, releaseRepository } from '../src/app-update.js';
import { cleanupTestDirectory } from './cleanup.js';

const binary = Buffer.alloc(2048, 37), hash = createHash('sha256').update(binary).digest('hex');
const base = `https://github.com/${releaseRepository}/releases/download/v1.1.0/`;
const manifest = { version: '1.1.0', file: installerName, size: binary.length, sha256: hash };
function release() { return { tag_name: 'v1.1.0', assets: [ { name: installerName, browser_download_url: base + installerName, size: binary.length, digest: `sha256:${hash}` }, { name: 'review-desk-update.json', browser_download_url: base + 'review-desk-update.json' } ] }; }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function setup(t, fetcher) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-desk-test-update-')); t.after(() => cleanupTestDirectory(directory));
  const launched = [];
  return { directory, launched, updater: new AppUpdater(directory, '1.0.0', { fetcher, launch: async file => launched.push(file) }) };
}
test('updater verifies the release, follows only GitHub CDN redirects, downloads exact bytes and launches only after confirmation', async t => {
  const { updater, launched } = await setup(t, async (url, options) => {
    if (url.startsWith('https://api.github.com/')) { assert.equal(options.redirect, 'error'); return json(release()); }
    assert.equal(options.redirect, 'manual');
    if (url.endsWith('.json')) return json(manifest);
    if (url === base + installerName) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/test.exe' } });
    assert.equal(url, 'https://release-assets.githubusercontent.com/test.exe'); return new Response(binary);
  });
  assert.equal((await updater.check()).available, true);
  await assert.rejects(updater.install(false), { code: 'UPDATE_CONFIRM' }); assert.equal(launched.length, 0);
  assert.equal((await updater.install(true)).phase, 'installing'); assert.equal(launched.length, 1);
  assert.deepEqual(await readFile(launched[0]), binary);
  await assert.rejects(updater.install(true), { code: 'UPDATE_BUSY' });
});
test('tampered bytes, external release URLs, and external CDN redirects never run', async t => {
  for (const attack of ['bytes', 'asset', 'redirect', 'digest']) await t.test(attack, async t => {
    const { updater, launched } = await setup(t, async url => {
      if (url.startsWith('https://api.github.com/')) { const value = release(); if (attack === 'asset') value.assets[0].browser_download_url = 'https://example.com/setup.exe'; if (attack === 'digest') value.assets[0].digest = 'sha256:' + 'a'.repeat(64); return json(value); }
      if (url.endsWith('.json')) return json(manifest);
      if (attack === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://example.com/setup.exe' } });
      return new Response(Buffer.alloc(binary.length, 12));
    });
    const checked = await updater.check();
    const outcome = checked.available ? await updater.install(true) : checked;
    assert.equal(outcome.phase, 'error'); assert.equal(launched.length, 0);
  });
});
test('semantic versions and missing releases cannot downgrade an installation', async t => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1); assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  assert.throws(() => compareVersions('../1.2.0', '1.1.0'));
  const { updater } = await setup(t, async () => new Response(null, { status: 404 }));
  assert.equal((await updater.check()).available, false); await assert.rejects(updater.install(true), { code: 'UPDATE_NOT_READY' });
});
