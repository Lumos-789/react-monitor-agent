import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// 编译产物在 core/dist-test/test,源码在 core/test —— 两者上两级都是 core/
export const CORE_ROOT = resolve(TEST_DIR, '..', '..');
export const REPO_ROOT = dirname(CORE_ROOT);
export const DEMO_FIXTURE = join(REPO_ROOT, 'fixtures', 'demo-fixture.jsonl');

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'rma-core-test-'));
}
