// 状态机(fold)测试:demo fixture 重建 + 状态翻转 + 分支留痕 + supplement 语义 + invariant。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fold } from '../src/fold.js';
import { validateDecisionInput, nextBranchId, statusAfterDecision } from '../src/domain.js';
import { ApiError } from '../src/errors.js';
import type { Checkpoint, TimelineEvent } from '../src/types.js';
import { DEMO_FIXTURE } from './util.js';

function loadFixture(workId = 'w-demo-report'): TimelineEvent[] {
  return readFileSync(DEMO_FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TimelineEvent)
    .filter((e) => e.workId === workId);
}

function minimalWorkCreated(): TimelineEvent {
  return {
    id: 'ev-w1-1',
    workId: 'w1',
    seq: 1,
    ts: '2026-11-01T00:00:00.000Z',
    branch: 'main',
    actor: 'agent:t',
    type: 'work.created',
    work: {
      id: 'w1',
      track: 'work',
      kind: 'research',
      title: 't',
      agent: 't',
      status: 'active',
      activeBranch: 'main',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      lastSeq: 1,
    },
  };
}

function openCheckpoint(seq: number, id: string, type: Checkpoint['type']): TimelineEvent {
  return {
    id: `ev-w1-${seq}`,
    workId: 'w1',
    seq,
    ts: '2026-11-01T00:00:01.000Z',
    branch: 'main',
    actor: 'agent:t',
    type: 'checkpoint.raised',
    checkpoint: {
      id,
      workId: 'w1',
      type,
      origin: 'agent',
      title: 'cp',
      body: '',
      evidence: [],
      raisedAt: '2026-11-01T00:00:01.000Z',
      raisedBy: 't',
      status: 'open',
    },
  };
}

test('fold: demo fixture(23 事件)完整重建 —— done/b2/分支留痕/3 检查点全 resolved', () => {
  const events = loadFixture();
  assert.equal(events.length, 23);
  const f = fold(events);

  assert.equal(f.work.id, 'w-demo-report');
  assert.equal(f.work.status, 'done');
  assert.equal(f.work.activeBranch, 'b2');
  assert.equal(f.work.lastSeq, 23);
  assert.equal(f.work.agent, 'dsh-worker-1');

  // 分支:main 关闭留痕(closedByDecisionId=redirect 决策),b2 活跃
  assert.equal(f.branches.length, 2);
  const main = f.branches.find((b) => b.id === 'main');
  const b2 = f.branches.find((b) => b.id === 'b2');
  assert.ok(main && b2);
  assert.equal(main.status, 'closed');
  assert.equal(main.closedByDecisionId, 'dec-w-demo-report-6');
  assert.ok(main.closedAt);
  assert.equal(b2.status, 'active');
  assert.equal(b2.closedAt, undefined);

  // 检查点:3 个全 resolved,outcome 带分支操作
  assert.equal(f.checkpoints.length, 3);
  const [plan, risk, delivery] = f.checkpoints;
  assert.ok(plan && risk && delivery);
  assert.equal(plan.id, 'cp-w-demo-report-4');
  assert.equal(plan.status, 'resolved');
  assert.deepEqual(plan.outcome, { action: 'redirect', branchClosed: 'main', branchOpened: 'b2' });
  assert.equal(plan.resolvedByDecisionId, 'dec-w-demo-report-6');
  assert.equal(risk.outcome?.action, 'approve');
  assert.equal(delivery.outcome?.action, 'deliver');
  assert.equal(delivery.outcome?.branchClosed, undefined);

  // 决策:3 个,全部 ack(consumedAt 非空)
  assert.equal(f.decisions.length, 3);
  for (const d of f.decisions) assert.ok(d.consumedAt, `decision ${d.id} should be consumed`);

  // summary 被最后一条 artifact 刷新
  assert.ok(f.work.summary?.startsWith('《竞品调研报告》全文 v1'));
});

test('fold: waiting/active 状态翻转由事件流正确得出', () => {
  const events = loadFixture();
  const cut = (seq: number) => fold(events.filter((e) => e.seq <= seq));
  assert.equal(cut(4).work.status, 'active', 'seq4: 检查点刚 raised,work.status(waiting) 还没到');
  assert.equal(cut(5).work.status, 'waiting');
  assert.equal(cut(6).work.status, 'active', 'decision.made(redirect) 即置回 active');
  assert.equal(cut(11).work.status, 'active', 'seq11: 风险检查点刚 raised,waiting 事件在 seq12');
  assert.equal(cut(12).work.status, 'waiting');
  assert.equal(cut(13).work.status, 'active', 'decision.made(approve) 即置回 active');
  assert.equal(cut(15).work.status, 'active');
  assert.equal(cut(19).work.status, 'waiting');
  assert.equal(cut(20).work.status, 'done');
});

test('fold: supplement 不解决检查点、不改 work 状态', () => {
  const events = [
    minimalWorkCreated(),
    openCheckpoint(2, 'cp-w1-2', 'plan'),
    {
      id: 'ev-w1-3',
      workId: 'w1',
      seq: 3,
      ts: '2026-11-01T00:00:02.000Z',
      branch: 'main',
      actor: 'human',
      type: 'decision.made',
      decision: {
        id: 'dec-w1-3',
        workId: 'w1',
        checkpointId: 'cp-w1-2',
        action: 'supplement',
        actor: 'human',
        createdAt: '2026-11-01T00:00:02.000Z',
        consumedAt: null,
      },
    } as TimelineEvent,
  ];
  const f = fold(events);
  assert.equal(f.checkpoints[0]?.status, 'open');
  assert.equal(f.work.status, 'active');
  assert.equal(f.decisions.length, 1);
  assert.equal(f.decisions[0]?.consumedAt, null);
});

test('fold: 同时两个 open 检查点 → 违 invariant 抛错(fail-loud)', () => {
  const events = [minimalWorkCreated(), openCheckpoint(2, 'cp-w1-2', 'plan'), openCheckpoint(3, 'cp-w1-3', 'risk')];
  assert.throws(() => fold(events), /invariant/);
});

test('fold: 非 work.created 开头 → 抛错', () => {
  const events = [openCheckpoint(1, 'cp-w1-1', 'plan')];
  assert.throws(() => fold(events), /work\.created/);
});

test('domain: 动作矩阵校验(ALLOWED_ACTIONS)与 redirect 必带 text', () => {
  const mk = (type: Checkpoint['type']): Checkpoint => ({
    id: 'cp',
    workId: 'w1',
    type,
    origin: 'agent',
    title: 't',
    body: '',
    evidence: [],
    raisedAt: '2026-11-01T00:00:00.000Z',
    raisedBy: 't',
    status: 'open',
  });

  assert.equal(validateDecisionInput(mk('plan'), 'approve', undefined), 'approve');
  assert.equal(validateDecisionInput(mk('delivery'), 'deliver', undefined), 'deliver');

  // delivery 检查点上 approve → INVALID_ACTION(矩阵:delivery 只允许 deliver/reject/supplement)
  assert.throws(() => validateDecisionInput(mk('delivery'), 'approve', undefined), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, 'INVALID_ACTION');
    assert.equal(e.status, 400);
    return true;
  });
  // progress 检查点上 reject → INVALID_ACTION
  assert.throws(() => validateDecisionInput(mk('progress'), 'reject', undefined), /INVALID_ACTION|not allowed/);
  // plan 上 redirect 缺 text → INVALID_ACTION
  assert.throws(() => validateDecisionInput(mk('plan'), 'redirect', undefined), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, 'INVALID_ACTION');
    return true;
  });
  // 未知动作 → INVALID_ACTION
  assert.throws(() => validateDecisionInput(mk('plan'), 'destroy', undefined), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, 'INVALID_ACTION');
    return true;
  });
});

test('domain: 分支编号确定性(main→b2→b3)与决策后状态', () => {
  assert.equal(nextBranchId([{ id: 'main', openedAt: 't', status: 'active' }]), 'b2');
  assert.equal(
    nextBranchId([
      { id: 'main', openedAt: 't', status: 'closed' },
      { id: 'b2', openedAt: 't', status: 'active' },
    ]),
    'b3',
  );
  assert.equal(statusAfterDecision('deliver'), 'done');
  assert.equal(statusAfterDecision('approve'), 'active');
  assert.equal(statusAfterDecision('reject'), 'active');
  assert.equal(statusAfterDecision('redirect'), 'active');
  assert.equal(statusAfterDecision('supplement'), null);
});
