import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export async function cleanupTestDirectory(directory) {
  const resolved = path.resolve(directory), parent = path.resolve(os.tmpdir());
  if (!resolved.toLowerCase().startsWith(parent.toLowerCase() + path.sep) || !/^review-(desk|http)-test-/.test(path.basename(resolved))) throw new Error('Refusing to remove a non-test directory.');
  await rm(resolved, { recursive: true, force: true });
}
