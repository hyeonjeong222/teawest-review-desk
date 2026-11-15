import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function dataDirectory(env = process.env) {
  return env.REVIEW_DESK_DATA_DIR ? path.resolve(env.REVIEW_DESK_DATA_DIR) : path.join(root, '.local');
}
