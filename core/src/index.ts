// rma-core 入口:读 env → store(空目录自动灌 demo fixture)→ server.listen(127.0.0.1:8790)。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createCoreServer } from './server.js';
import { dataDirIsEmpty, defaultFixturePath, seedFromJsonl } from './seed.js';

const CORE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(CORE_ROOT);

function readVersion(): string {
  try {
    return String(JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const home = process.env.RMA_HOME && process.env.RMA_HOME.trim() !== '' ? process.env.RMA_HOME : join(homedir(), '.rma');
const port = Number(process.env.RMA_PORT && process.env.RMA_PORT.trim() !== '' ? process.env.RMA_PORT : 8790);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[rma-core] fail-loud: invalid RMA_PORT "${process.env.RMA_PORT}"`);
  process.exit(1);
}

// 必须在构造 Store 之前判空:Store 构造即物化 works.json,会把「空目录」变成「非空」。
const fixturePath =
  process.env.RMA_SEED_FIXTURE && process.env.RMA_SEED_FIXTURE.trim() !== '' ? process.env.RMA_SEED_FIXTURE : defaultFixturePath();
const wantSeed = process.env.RMA_NO_SEED !== '1' && dataDirIsEmpty(home);

const store = new Store(home);
if (wantSeed) {
  if (existsSync(fixturePath)) {
    const r = seedFromJsonl(store, fixturePath);
    console.log(`[rma-core] data dir empty: seeded demo fixture ${fixturePath} → ${r.works} work(s), ${r.events} event(s)`);
  } else {
    console.error(`[rma-core] data dir ${home} is empty but seed fixture ${fixturePath} does not exist; starting empty`);
  }
}

const staticDirs: string[] =
  process.env.RMA_STATIC_DIR && process.env.RMA_STATIC_DIR.trim() !== ''
    ? [process.env.RMA_STATIC_DIR]
    : [join(REPO_ROOT, 'app', 'dist'), join(REPO_ROOT, 'board', 'dist')];

const server = createCoreServer(store, { version: readVersion(), staticDirs });

server.listen(port, '127.0.0.1', () => {
  const staticNote = staticDirs.find((d) => existsSync(d));
  console.log(`[rma-core] listening on http://127.0.0.1:${port} (RMA_HOME=${home})`);
  if (staticNote) console.log(`[rma-core] serving static board from ${staticNote}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  });
}
