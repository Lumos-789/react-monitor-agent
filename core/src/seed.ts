// seed —— 把 JSONL fixture 灌进 store(npm run seed -- <file>;启动时空目录自动灌入)。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TimelineEvent } from './types.js';
import { Store } from './store.js';

const CORE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function defaultFixturePath(): string {
  return join(dirname(CORE_ROOT), 'fixtures', 'demo-fixture.jsonl');
}

/** 数据目录是否为空(无 works.json、works/ 空、无 context 日志)→ 启动时自动灌 fixture。 */
export function dataDirIsEmpty(home: string): boolean {
  if (existsSync(join(home, 'works.json'))) return false;
  const worksDir = join(home, 'works');
  if (existsSync(worksDir) && readdirSync(worksDir).length > 0) return false;
  if (existsSync(join(home, 'context', 'entries.jsonl'))) return false;
  return true;
}

export function seedFromJsonl(store: Store, file: string): { works: number; events: number } {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const events: TimelineEvent[] = lines.map((line, i) => {
    try {
      return JSON.parse(line) as TimelineEvent;
    } catch (err) {
      throw new Error(`seed: ${file} line ${i + 1} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
  });
  const byWork = new Map<string, TimelineEvent[]>();
  for (const ev of events) {
    if (!ev || typeof ev.workId !== 'string') throw new Error(`seed: ${file} contains an event without workId`);
    const list = byWork.get(ev.workId);
    if (list) list.push(ev);
    else byWork.set(ev.workId, [ev]);
  }
  for (const [workId, evs] of byWork) store.ingestWorkEvents(workId, evs);
  return { works: byWork.size, events: events.length };
}

/** 启动自动 seed 的判空规则在 index.ts:必须先判空再构造 Store(Store 构造会物化 works.json)。 */

// ── CLI:npm run seed -- <file>(缺省用 demo fixture) ─────────────
function invokedAsCli(): boolean {
  if (!process.argv[1]) return false;
  const entered = resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return entered === self || entered === self.replace(/\.js$/, '.ts') || pathToFileURL(entered).href === import.meta.url;
}

if (invokedAsCli()) {
  const file = process.argv[2] ?? defaultFixturePath();
  const home = process.env.RMA_HOME ?? join(homedir(), '.rma');
  const store = new Store(home);
  const r = seedFromJsonl(store, file);
  console.log(`seeded ${r.works} work(s), ${r.events} event(s) from ${file} into ${home}`);
}
