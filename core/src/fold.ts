// fold —— 状态如何从日志得出(tech-design §1.1)。纯函数,core 与 board 共用(D5),无 IO。
import type { BranchInfo, Checkpoint, Decision, TimelineEvent, WorkItem, WorkStatus } from './types.js';

export interface Folded {
  work: WorkItem;
  checkpoints: Checkpoint[];
  decisions: Decision[];
  branches: BranchInfo[];
}

const SUMMARY_MAX_CHARS = 120;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 截 120 字(按 code point,不截半emoji) */
export function truncateSummary(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= SUMMARY_MAX_CHARS) return text;
  return chars.slice(0, SUMMARY_MAX_CHARS).join('');
}

function isResolving(action: string): boolean {
  return action !== 'supplement';
}

function statusAfterResolving(action: string): WorkStatus {
  return action === 'deliver' ? 'done' : 'active';
}

/**
 * 重放一个 work 的事件流,得出 work 快照 + 检查点/决策/分支投影。
 * fail-loud:首事件必须 work.created;违「同时至多一个 open 检查点」invariant、
 * 决策引用未知/已决检查点、ack 引用未知决策 → 抛错(启动时即报)。
 */
export function fold(events: TimelineEvent[]): Folded {
  const first = events[0];
  if (!first || first.type !== 'work.created') {
    throw new Error('fold: event stream must start with work.created');
  }
  const work = clone(first.work);
  const branches: BranchInfo[] = [{ id: work.activeBranch, openedAt: work.createdAt, status: 'active' }];
  const checkpoints: Checkpoint[] = [];
  const decisions: Decision[] = [];

  const openCheckpoint = (): Checkpoint | undefined => checkpoints.find((c) => c.status === 'open');

  for (const ev of events) {
    // 规则 1:此后每个事件推进 lastSeq/updatedAt
    work.lastSeq = ev.seq;
    work.updatedAt = ev.ts;

    switch (ev.type) {
      case 'work.created': {
        if (ev !== first) throw new Error(`fold: duplicate work.created at seq ${ev.seq}`);
        break;
      }
      case 'work.status': {
        work.status = ev.status;
        break;
      }
      case 'note': {
        work.summary = truncateSummary(ev.text);
        break;
      }
      case 'artifact': {
        work.summary = truncateSummary(ev.title);
        break;
      }
      case 'checkpoint.raised': {
        const open = openCheckpoint();
        if (open) {
          throw new Error(
            `fold invariant violated (work ${ev.workId} seq ${ev.seq}): checkpoint ${ev.checkpoint.id} raised while ${open.id} is still open`,
          );
        }
        checkpoints.push(clone(ev.checkpoint));
        break;
      }
      case 'decision.made': {
        const decision = clone(ev.decision);
        decisions.push(decision);
        if (isResolving(decision.action)) {
          const cp = checkpoints.find((c) => c.id === decision.checkpointId);
          if (!cp) {
            throw new Error(`fold: decision ${decision.id} references unknown checkpoint ${decision.checkpointId}`);
          }
          if (cp.status !== 'open') {
            throw new Error(`fold: decision ${decision.id} targets checkpoint ${cp.id} already ${cp.status}`);
          }
          cp.status = 'resolved';
          cp.resolvedByDecisionId = decision.id;
          cp.resolvedAt = decision.createdAt;
          const outcome: Checkpoint['outcome'] = { action: decision.action };
          if (ev.branchClosed !== undefined) outcome.branchClosed = ev.branchClosed;
          if (ev.branchOpened !== undefined) outcome.branchOpened = ev.branchOpened;
          cp.outcome = outcome;
          // 规则 2:deliver → done;approve/reject/redirect → active;supplement 不动状态
          work.status = statusAfterResolving(decision.action);
        }
        // 规则 3:decision.made 携带被关闭的旧分支;其后事件携带新分支
        if (ev.branchClosed !== undefined) {
          const closed = branches.find((b) => b.id === ev.branchClosed);
          if (closed) {
            closed.status = 'closed';
            closed.closedAt = ev.ts;
            closed.closedByDecisionId = decision.id;
          }
        }
        if (ev.branchOpened !== undefined) {
          if (!branches.some((b) => b.id === ev.branchOpened)) {
            branches.push({ id: ev.branchOpened, openedAt: ev.ts, status: 'active' });
          }
          work.activeBranch = ev.branchOpened;
        }
        break;
      }
      case 'decision.acked': {
        const d = decisions.find((x) => x.id === ev.decisionId);
        if (!d) throw new Error(`fold: ack references unknown decision ${ev.decisionId}`);
        if (d.consumedAt == null) d.consumedAt = ev.ts;
        break;
      }
      case 'branch.closed': {
        const closed = branches.find((b) => b.id === ev.branch);
        if (closed) {
          closed.status = 'closed';
          closed.closedAt = ev.ts;
        }
        break;
      }
      case 'tool':
      case 'context.consumed':
      case 'context.proposed':
        break;
    }
  }

  return { work, checkpoints, decisions, branches };
}
