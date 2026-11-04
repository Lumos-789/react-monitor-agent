// HTTP API 集成测试:node:test + 真实 http server(随机端口)+ fetch。
// 覆盖:health / works(建+幂等+撞id) / events / checkpoints(409) / decisions(矩阵+分支) /
// inbox(长轮询+ack 幂等) / timeline(sinceSeq) / evidence(dataB64 落盘取回) / context(draft→deliver 翻 accepted) /
// 错误信封 / CORS / Host 校验(DNS rebinding) / fixture seed 重建。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { Store } from '../src/store.js';
import { createCoreServer } from '../src/server.js';
import { dataDirIsEmpty, seedFromJsonl } from '../src/seed.js';
import { DEMO_FIXTURE, tempHome } from './util.js';

let store: Store;
let server: Server;
let base: string;

interface Resp {
  status: number;
  headers: Headers;
  json: () => Promise<any>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    headers: res.headers,
    json: () => res.json(),
    arrayBuffer: () => res.arrayBuffer(),
  };
}

const png1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => {
  store = new Store(tempHome());
  server = createCoreServer(store, { version: 'test-1.0.0', staticDirs: [] });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

test('GET /api/health → 200 信封 ok:true', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.data.version, 'test-1.0.0');
  assert.equal(j.data.works, 0);
  assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('POST /api/works → 201;重复同参 → 200 + X-Idempotent-Replay;异参 → 409 ID_EXISTS', async () => {
  const payload = { id: 'w-t1', track: 'work', kind: 'coding', title: '小工具站', agent: 'tester', template: 'coding-v1' };
  const r1 = await call('POST', '/api/works', payload);
  assert.equal(r1.status, 201);
  const j1 = await r1.json();
  assert.equal(j1.ok, true);
  assert.equal(j1.data.id, 'w-t1');
  assert.equal(j1.data.status, 'active');
  assert.equal(j1.data.activeBranch, 'main');
  assert.equal(r1.headers.get('x-idempotent-replay'), null);

  const r2 = await call('POST', '/api/works', payload);
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get('x-idempotent-replay'), 'true');
  assert.equal((await r2.json()).data.id, 'w-t1');

  const r3 = await call('POST', '/api/works', { ...payload, title: '别的标题' });
  assert.equal(r3.status, 409);
  const j3 = await r3.json();
  assert.equal(j3.ok, false);
  assert.equal(j3.error.code, 'ID_EXISTS');

  const r4 = await call('POST', '/api/works', { track: 'work', kind: 'x', title: 'x', agent: 'a' });
  assert.equal(r4.status, 201);
  assert.match((await r4.json()).data.id, /^w-[a-z0-9]{6}$/);

  const r5 = await call('POST', '/api/works', { track: 'banana', kind: 'x', title: 'x', agent: 'a' });
  assert.equal(r5.status, 400);
  assert.equal((await r5.json()).error.code, 'BAD_REQUEST');
});

test('GET /api/works 列表按 updatedAt 降序 + track/status 过滤', async () => {
  const r = await call('GET', '/api/works');
  assert.equal(r.status, 200);
  const list = (await r.json()).data as any[];
  assert.equal(list.length, 2);
  assert.ok(list[0].updatedAt >= list[1].updatedAt, '按 updatedAt 降序');
  assert.ok(list.some((w) => w.id === 'w-t1'));
  const r2 = await call('GET', '/api/works?status=active');
  assert.equal((await r2.json()).data.length, 2);
  const r3 = await call('GET', '/api/works?status=waiting');
  assert.equal((await r3.json()).data.length, 0);
  const r4 = await call('GET', '/api/works?status=nonsense');
  assert.equal(r4.status, 400);
});

test('POST /api/works/:id/events(note/artifact/tool)→ 201 事件带回 seq;work.summary 刷新', async () => {
  const r1 = await call('POST', '/api/works/w-t1/events', { type: 'note', text: '确定了技术选型:纯 Node 内置模块。' });
  assert.equal(r1.status, 201);
  const e1 = (await r1.json()).data;
  assert.equal(e1.type, 'note');
  assert.equal(e1.seq, 2);
  assert.equal(e1.branch, 'main');
  assert.equal(e1.actor, 'agent:tester');

  const r2 = await call('POST', '/api/works/w-t1/events', {
    type: 'artifact',
    title: 'v0 骨架',
    evidence: [{ kind: 'code_diff', text: '--- /dev/null\n+++ index.ts\n@@\n+hello' }],
  });
  assert.equal(r2.status, 201);
  const r3 = await call('POST', '/api/works/w-t1/events', { type: 'tool', tool: 'bash', summary: 'npm run build 通过' });
  assert.equal(r3.status, 201);

  const r4 = await call('GET', '/api/works/w-t1');
  assert.equal((await r4.json()).data.work.summary, 'v0 骨架');

  // work.status 只接受 abandoned
  const r5 = await call('POST', '/api/works/w-t1/events', { type: 'work.status', status: 'done' });
  assert.equal(r5.status, 400);
  const r6 = await call('POST', '/api/works/w-t1/events', { type: 'nonsense' });
  assert.equal(r6.status, 400);
  assert.equal((await r6.json()).error.code, 'BAD_REQUEST');
  const r7 = await call('POST', '/api/works/w-nope/events', { type: 'note', text: 'x' });
  assert.equal(r7.status, 404);
  assert.equal((await r7.json()).error.code, 'NOT_FOUND');
});

test('POST checkpoints → 201 且 work=waiting;重复 → 409 CHECKPOINT_OPEN;evidence dataB64 落盘并可取回', async () => {
  const r = await call('POST', '/api/works/w-t1/checkpoints', {
    type: 'plan',
    origin: 'template',
    title: '方案A:Express 还是裸 http',
    body: '裸 http,零依赖。',
    evidence: [
      { kind: 'text', text: '对比:依赖数 0 vs 30+' },
      { kind: 'image', dataB64: png1x1, caption: '架构草图' },
    ],
  });
  assert.equal(r.status, 201);
  const cp = (await r.json()).data;
  assert.equal(cp.status, 'open');
  assert.equal(cp.type, 'plan');
  assert.match(cp.id, /^cp-w-t1-\d+$/);
  const img = cp.evidence.find((e: any) => e.kind === 'image');
  assert.ok(img, 'image evidence normalized');
  assert.match(img.path, /^evidence\/[a-z0-9]{6}\.png$/);
  assert.ok(img.url.startsWith('/api/works/w-t1/evidence/'));

  const r2 = await call('GET', '/api/works/w-t1');
  const j2 = await r2.json();
  assert.equal(j2.data.work.status, 'waiting');
  assert.equal(j2.data.openCheckpointId, cp.id);

  const r3 = await call('POST', '/api/works/w-t1/checkpoints', { type: 'risk', title: '又一个' });
  assert.equal(r3.status, 409);
  assert.equal((await r3.json()).error.code, 'CHECKPOINT_OPEN');

  // 证据文件取回:字节一致 + Content-Type
  const fileId = img.url.split('/').pop();
  const r4 = await call('GET', `/api/works/w-t1/evidence/${fileId}`);
  assert.equal(r4.status, 200);
  assert.equal(r4.headers.get('content-type'), 'image/png');
  const got = Buffer.from(await r4.arrayBuffer());
  assert.equal(got.toString('base64'), png1x1);

  const r5 = await call('GET', '/api/works/w-t1/evidence/nope999');
  assert.equal(r5.status, 404);

  (globalThis as any).__cpPlanId = cp.id;
});

test('POST decisions:动作矩阵越界 400 INVALID_ACTION;redirect 缺 text 400', async () => {
  const cpId = (globalThis as any).__cpPlanId as string;
  const r1 = await call('POST', `/api/checkpoints/${cpId}/decisions`, { action: 'deliver' });
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error.code, 'INVALID_ACTION');
  const r2 = await call('POST', `/api/checkpoints/${cpId}/decisions`, { action: 'redirect' });
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).error.code, 'INVALID_ACTION');
  const r3 = await call('POST', '/api/checkpoints/cp-nope/decisions', { action: 'approve' });
  assert.equal(r3.status, 404);
});

test('POST decision redirect → 分支 main 关闭留痕、b2 挂 alt、work 回 active;时间线可重建', async () => {
  const cpId = (globalThis as any).__cpPlanId as string;
  const r = await call('POST', `/api/checkpoints/${cpId}/decisions`, {
    action: 'redirect',
    text: '别纠结框架,直接裸 http。',
  });
  assert.equal(r.status, 201);
  const dec = (await r.json()).data;
  assert.equal(dec.action, 'redirect');
  assert.equal(dec.consumedAt, null);
  assert.match(dec.id, /^dec-w-t1-\d+$/);

  const r2 = await call('GET', '/api/works/w-t1/timeline');
  assert.equal(r2.status, 200);
  const tl = (await r2.json()).data;
  assert.equal(tl.work.status, 'active');
  assert.equal(tl.work.activeBranch, 'b2');
  const main = tl.branches.find((b: any) => b.id === 'main');
  const b2 = tl.branches.find((b: any) => b.id === 'b2');
  assert.equal(main.status, 'closed');
  assert.equal(main.closedByDecisionId, dec.id);
  assert.equal(b2.status, 'active');
  const planCp = tl.checkpoints.find((c: any) => c.id === cpId);
  assert.equal(planCp.status, 'resolved');
  assert.deepEqual(planCp.outcome, { action: 'redirect', branchClosed: 'main', branchOpened: 'b2' });

  // 已决检查点再决策 → 409 ALREADY_RESOLVED
  const r3 = await call('POST', `/api/checkpoints/${cpId}/decisions`, { action: 'approve' });
  assert.equal(r3.status, 409);
  assert.equal((await r3.json()).error.code, 'ALREADY_RESOLVED');
});

test('GET inbox:决策按序可拉、ack 后清空、重复 ack 幂等;wait=0 立即返回', async () => {
  const r = await call('GET', '/api/works/w-t1/inbox');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.data.decisions.length, 1);
  assert.equal(j.data.decisions[0].action, 'redirect');
  const decId = j.data.decisions[0].id;

  const ack = await call('POST', `/api/decisions/${decId}/ack`);
  assert.equal(ack.status, 200);
  assert.ok((await ack.json()).data.consumedAt);

  const r2 = await call('GET', '/api/works/w-t1/inbox');
  assert.equal((await r2.json()).data.decisions.length, 0);

  const ack2 = await call('POST', `/api/decisions/${decId}/ack`);
  assert.equal(ack2.status, 200);
  const r3 = await call('GET', '/api/works/w-t1/inbox');
  const inboxEvents = (await r3.json()).data.decisions;
  assert.equal(inboxEvents.length, 0, '重复 ack 不产生新 inbox 项');

  const r4 = await call('POST', '/api/decisions/dec-nope/ack');
  assert.equal(r4.status, 404);

  // 长轮询:空 inbox + wait=1 → 超时返回空数组
  const t0 = Date.now();
  const r5 = await call('GET', '/api/works/w-t1/inbox?wait=1');
  assert.equal((await r5.json()).data.decisions.length, 0);
  assert.ok(Date.now() - t0 >= 900, '长轮询应等到超时');
});

test('supplement 决策:不解决检查点(仍 waiting/仍 open),进 inbox', async () => {
  const cp = (await (await call('POST', '/api/works/w-t1/checkpoints', { type: 'risk', title: '拿不准端口' })).json()).data;
  const r = await call('POST', `/api/checkpoints/${cp.id}/decisions`, {
    action: 'supplement',
    text: '端口用 8790,契约已定。',
  });
  assert.equal(r.status, 201);
  const w = (await (await call('GET', '/api/works/w-t1')).json()).data;
  assert.equal(w.work.status, 'waiting');
  assert.equal(w.openCheckpointId, cp.id);
  const inbox = (await (await call('GET', '/api/works/w-t1/inbox')).json()).data.decisions;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].action, 'supplement');
  await call('POST', `/api/decisions/${inbox[0].id}/ack`);

  // supplement 之后人继续表态 approve,检查点才解决(语义约定:supplement 不解决)
  const appr = await call('POST', `/api/checkpoints/${cp.id}/decisions`, { action: 'approve' });
  assert.equal(appr.status, 201);
  const apprDec = (await appr.json()).data;
  const w2 = (await (await call('GET', '/api/works/w-t1')).json()).data;
  assert.equal(w2.work.status, 'active');
  assert.equal(w2.openCheckpointId, null);
  await call('POST', `/api/decisions/${apprDec.id}/ack`);
});

test('timeline ?sinceSeq 增量只返回 seq>N 的事件', async () => {
  const all = (await (await call('GET', '/api/works/w-t1/timeline')).json()).data.events;
  const maxSeq = all[all.length - 1].seq;
  const inc = (await (await call('GET', `/api/works/w-t1/timeline?sinceSeq=${maxSeq - 2}`)).json()).data.events;
  assert.equal(inc.length, 2);
  assert.ok(inc.every((e: any) => e.seq > maxSeq - 2));
  const bad = await call('GET', '/api/works/w-t1/timeline?sinceSeq=abc');
  assert.equal(bad.status, 400);
  const none = await call('GET', '/api/works/w-nope/timeline');
  assert.equal(none.status, 404);
});

test('context:POST draft → deliver 决策后翻 accepted;q/status 过滤;单条全文', async () => {
  const r1 = await call('POST', '/api/context', {
    title: '选型结论:零依赖优先',
    kind: 'knowledge',
    tags: ['coding', '选型'],
    content: '本机 localhost 工具默认零运行时依赖。',
    sourceWorkId: 'w-t1',
  });
  assert.equal(r1.status, 201);
  const entry = (await r1.json()).data;
  assert.equal(entry.status, 'draft');
  assert.match(entry.id, /^ctx-[a-z0-9]{6}$/);

  const rQ = await call('GET', '/api/context?q=选型');
  assert.equal((await rQ.json()).data.length, 1);
  const rTag = await call('GET', '/api/context?q=coding');
  assert.equal((await rTag.json()).data.length, 1);
  const rS = await call('GET', '/api/context?status=accepted');
  assert.equal((await rS.json()).data.length, 0);

  const one = await call('GET', `/api/context/${entry.id}`);
  assert.equal((await one.json()).data.content, '本机 localhost 工具默认零运行时依赖。');
  const r404 = await call('GET', '/api/context/ctx-nope');
  assert.equal(r404.status, 404);

  // 走完 delivery → deliver,sourceWork 的 draft 条目翻 accepted
  const cp = (await (await call('POST', '/api/works/w-t1/checkpoints', { type: 'delivery', origin: 'template', title: '交付 v1' })).json()).data;
  const dec = (await (await call('POST', `/api/checkpoints/${cp.id}/decisions`, { action: 'deliver', text: '收货' })).json()).data;
  assert.equal(dec.action, 'deliver');

  const w = (await (await call('GET', '/api/works/w-t1')).json()).data;
  assert.equal(w.work.status, 'done');

  const accepted = (await (await call('GET', '/api/context?status=accepted')).json()).data;
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].id, entry.id);
  assert.equal(accepted[0].status, 'accepted');
});

test('context.proposed 事件物化 draft 条目(deliver 之后 → 保持 draft,与 fixture 语义一致)', async () => {
  const r = await call('POST', '/api/works/w-t1/events', {
    type: 'context.proposed',
    entry: { title: '新提案', kind: 'rule', tags: ['t'], content: '内容' },
  });
  assert.equal(r.status, 201);
  const list = (await (await call('GET', '/api/context?status=draft')).json()).data;
  const mine = list.filter((e: { sourceWorkId?: string }) => e.sourceWorkId === 'w-t1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].sourceWorkId, 'w-t1');
});

test('CORS:白名单 origin 回显、OPTIONS 204、白名单外不加头', async () => {
  const r1 = await call('GET', '/api/health', undefined, { origin: 'http://localhost:5173' });
  assert.equal(r1.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(r1.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');

  const res = await fetch(base + '/api/works', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:5173' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
  assert.equal(res.headers.get('access-control-max-age'), '600');
  await res.arrayBuffer();

  const r3 = await call('GET', '/api/health', undefined, { origin: 'http://evil.example' });
  assert.equal(r3.headers.get('access-control-allow-origin'), null);
});

test('demo fixture:seedFromJsonl 灌入后 store 重建完整(done/b2/23事件/ctx draft)', async () => {
  const s = new Store(tempHome());
  const r = seedFromJsonl(s, DEMO_FIXTURE);
  assert.equal(r.works, 3);
  assert.equal(r.events, 51);

  const works = s.listWorks({});
  assert.equal(works.length, 3);
  const demo = works.find((w) => w.id === 'w-demo-report');
  assert.ok(demo);
  assert.equal(demo.status, 'done');
  assert.equal(demo.activeBranch, 'b2');

  const tl = s.timeline('w-demo-report', 0);
  assert.equal(tl.events.length, 23);
  assert.equal(tl.branches.find((b) => b.id === 'main')?.status, 'closed');
  assert.equal(tl.checkpoints.length, 3);
  assert.ok(tl.checkpoints.every((c) => c.status === 'resolved'));

  const ctx = s.contextList({ q: '方法论' });
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].id, 'ctx-9f3k71');
  assert.equal(ctx[0].status, 'draft');

  // 灌入后再 seed 同一 fixture:已存在,跳过且不报错
  const again = seedFromJsonl(s, DEMO_FIXTURE);
  assert.equal(again.works, 3);
  assert.equal(s.listWorks({}).length, 3);
});

test('持久化往返:重启(新 Store 实例同 RMA_HOME)后状态一致', async () => {
  const home = tempHome();
  const s1 = new Store(home);
  const { work } = s1.createWork({ id: 'w-persist', track: 'context', kind: 'distill', title: 't', agent: 'a' });
  s1.raiseCheckpoint('w-persist', { type: 'plan', title: 'cp' });
  const s2 = new Store(home); // 重启:从 jsonl 重建
  const got = s2.getWork('w-persist');
  assert.equal(got.work.id, work.id);
  assert.equal(got.work.status, 'waiting');
  assert.ok(got.openCheckpointId);
});

test('启动自动 seed 判空顺序:先 dataDirIsEmpty 再构造 Store(否则 works.json 物化后永远非空)', async () => {
  const home = tempHome();
  assert.equal(dataDirIsEmpty(home), true, '全新目录判空');
  const s = new Store(home);
  assert.equal(dataDirIsEmpty(home), false, 'Store 构造物化 works.json 后非空 —— index.ts 必须先判空');
  seedFromJsonl(s, DEMO_FIXTURE);
  assert.equal(s.listWorks({}).length, 3);
});

// fetch 不允许覆盖 Host 头,用原生 http 直打。
function rawCall(host: string, path = '/api/health'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = httpRequest(
      { hostname: u.hostname, port: u.port, path, method: 'GET', headers: { host } },
      (res) => {
        let data = '';
        res.on('data', (c: string) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('Host 校验:非 localhost Host(DNS rebinding)→ 403,localhost 系 → 200', async () => {
  const evil = await rawCall('evil.example:8790');
  assert.equal(evil.status, 403);
  assert.ok(evil.body.includes('FORBIDDEN_HOST'));
  for (const h of ['127.0.0.1:8790', 'localhost:8790', '[::1]:8790']) {
    const ok = await rawCall(h);
    assert.equal(ok.status, 200, `Host ${h} 应放行`);
  }
});

test('4xx 拒绝留痕:每个被拒请求 warn 一行(方法 路径 → 状态 码: 原因),不走 error 通道', async () => {
  const warns: string[] = [];
  const errors: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    const r400 = await call('POST', '/api/works', { track: 'banana', kind: 'x', title: 'x', agent: 'a' });
    assert.equal(r400.status, 400);
    const r404 = await call('GET', '/api/works/w-nope/timeline');
    assert.equal(r404.status, 404);
    const r403 = await rawCall('evil.example:8790');
    assert.equal(r403.status, 403);
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
  const w400 = warns.find((w) => w.includes('POST /api/works → 400 BAD_REQUEST:'));
  assert.ok(w400 && w400.length > 'POST /api/works → 400 BAD_REQUEST:'.length, `400 应有一行含方法/路径/码+原因的 warn,实得: ${JSON.stringify(warns)}`);
  assert.ok(
    warns.some((w) => w.includes('GET /api/works/w-nope/timeline → 404 NOT_FOUND: work w-nope not found')),
    `404 应有一行 warn,实得: ${JSON.stringify(warns)}`,
  );
  assert.ok(
    warns.some((w) => w.includes('GET /api/health → 403 FORBIDDEN_HOST:')),
    `403 应有一行 warn,实得: ${JSON.stringify(warns)}`,
  );
  assert.equal(errors.length, 0, '4xx 归因调用方,不该打 error 通道');
});
