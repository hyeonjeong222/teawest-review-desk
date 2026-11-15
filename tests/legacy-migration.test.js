import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { migrateLegacyData } from '../src/legacy-migration.js';
import { dataDirectory } from '../src/data-directory.js';
import { cleanupTestDirectory } from './cleanup.js';

test('legacy migration copies only persistent data, keeps the source intact, and never overwrites existing PC data', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'review-desk-test-migrate-')); t.after(() => cleanupTestDirectory(base));
  const source = path.join(base, 'old'), target = path.join(base, 'installed', 'data');
  await mkdir(path.join(source, '.local'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'teawest-review-desk' }));
  await writeFile(path.join(source, '.local', 'state.json'), '{"drafts":{"one":{"text":"saved draft"}}}');
  await writeFile(path.join(source, '.local', 'naver-auth.json'), '{"encrypted":"ciphertext-only"}');
  await writeFile(path.join(source, '.local', 'server.log'), 'excluded');
  assert.deepEqual(await migrateLegacyData(source, target, { verify: false }), { migrated: true, files: 2 });
  assert.deepEqual((await readdir(target)).sort(), ['naver-auth.json', 'state.json']);
  assert.deepEqual(await readFile(path.join(source, '.local', 'naver-auth.json')), await readFile(path.join(target, 'naver-auth.json')));
  await writeFile(path.join(target, 'state.json'), '{"newer":"keep"}');
  assert.equal((await migrateLegacyData(source, target, { verify: false })).reason, 'already_initialized');
  assert.equal(await readFile(path.join(target, 'state.json'), 'utf8'), '{"newer":"keep"}');
  assert.equal(dataDirectory({ REVIEW_DESK_DATA_DIR: target }), target);
});
test('invalid data and interrupted credential transfers fail before initializing the new data directory', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'review-desk-test-migrate-')); t.after(() => cleanupTestDirectory(base));
  const source = path.join(base, 'old'), target = path.join(base, 'data');
  await mkdir(path.join(source, '.local'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), '{"name":"different-app"}');
  await assert.rejects(migrateLegacyData(source, target));
  await writeFile(path.join(source, 'package.json'), '{"name":"teawest-review-desk"}');
  await writeFile(path.join(source, '.local', 'state.json'), 'invalid');
  await assert.rejects(migrateLegacyData(source, target));
  await assert.rejects(readdir(target), { code: 'ENOENT' });
  await writeFile(path.join(source, '.local', 'credential-transfer-pending.json'), '{}');
  await assert.rejects(migrateLegacyData(source, target), /이전을 먼저/);
});
