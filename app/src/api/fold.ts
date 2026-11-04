/**
 * fold(重放)—— 契约 .agents/tech-design.md §1.1 的 board 侧实现。
 * 状态永远从事件日志得出;FIXTURE 与 LIVE 两种模式共用同一个 fold,杜绝两套状态机漂移(契约 D5)。
 */
import {
  isResolvingAction,
  type BranchInfo,
  type Checkpoint,
  type ContextEntry,
  type Decision,
  type ReplayNode,
  type TimelineEvent,
  type WorkItem,
} from '@/types'

export interface FoldedWork {
  work: WorkItem
  checkpoints: Checkpoint[]
  decisions: Decision[]
  branches: BranchInfo[]
  /** 本 work 时间线内蒸馏出的入库提案(事件序推进;deliver 时 draft→accepted 联动契约 §2.2) */
  contextProposed: ContextEntry[]
  consumedContext: string[]
}

const SUMMARY_MAX = 120

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

export function foldWorkEvents(input: TimelineEvent[]): FoldedWork {
  const events = [...input].sort((a, b) => a.seq - b.seq)
  const first = events[0]
  if (!first || first.type !== 'work.created') {
    throw new Error(`fold: 时间线必须以 work.created 开头(workId=${first?.workId ?? '?'})`)
  }

  const work: WorkItem = { ...first.work }
  const checkpoints: Checkpoint[] = []
  const decisions: Decision[] = []
  const branches: BranchInfo[] = [{ id: work.activeBranch || 'main', openedAt: work.createdAt, status: 'active' }]
  const contextProposed: ContextEntry[] = []
  const consumedContext: string[] = []

  const closeBranch = (id: string, ts: string, decisionId: string) => {
    const b = branches.find((x) => x.id === id)
    if (b && b.status === 'active') {
      b.status = 'closed'
      b.closedAt = ts
      b.closedByDecisionId = decisionId
    }
  }

  for (const ev of events) {
    work.lastSeq = ev.seq
    work.updatedAt = ev.ts

    switch (ev.type) {
      case 'work.created':
        break
      case 'work.status':
        work.status = ev.status
        break
      case 'note':
        work.summary = truncate(ev.text, SUMMARY_MAX)
        break
      case 'artifact':
        work.summary = truncate(ev.title, SUMMARY_MAX)
        break
      case 'tool':
        break
      case 'context.consumed':
        consumedContext.push(...ev.entryIds)
        break
      case 'context.proposed':
        contextProposed.push({ ...ev.entry })
        break
      case 'checkpoint.raised': {
        const openAlready = checkpoints.some((c) => c.status === 'open')
        if (openAlready) {
          // 契约 §1.1 不变量 6:同一 work 同时至多一个 open 检查点 —— fail-loud
          throw new Error(`fold: 违反「同时至多一个 open 检查点」不变量(seq=${ev.seq}, ${ev.checkpoint.id})`)
        }
        checkpoints.push({ ...ev.checkpoint, evidence: [...ev.checkpoint.evidence] })
        break
      }
      case 'decision.made': {
        const d: Decision = { ...ev.decision }
        decisions.push(d)
        const cp = checkpoints.find((c) => c.id === d.checkpointId)
        if (isResolvingAction(d.action)) {
          if (cp && cp.status === 'open') {
            cp.status = 'resolved'
            cp.resolvedByDecisionId = d.id
            cp.resolvedAt = ev.ts
            cp.outcome = { action: d.action, branchClosed: ev.branchClosed, branchOpened: ev.branchOpened }
          }
          work.status = d.action === 'deliver' ? 'done' : 'active'
        }
        if (ev.branchClosed) closeBranch(ev.branchClosed, ev.ts, d.id)
        if (ev.branchOpened) {
          if (!branches.some((b) => b.id === ev.branchOpened)) {
            branches.push({ id: ev.branchOpened, openedAt: ev.ts, status: 'active' })
          }
          work.activeBranch = ev.branchOpened
        }
        // 契约 §2.2:deliver 把本 work 名下 draft 上下文条目翻 accepted(事件序联动)
        if (d.action === 'deliver') {
          for (const e of contextProposed) {
            if (e.sourceWorkId === work.id && e.status === 'draft') e.status = 'accepted'
          }
        }
        break
      }
      case 'decision.acked': {
        const d = decisions.find((x) => x.id === ev.decisionId)
        if (d) d.consumedAt = ev.ts
        break
      }
      case 'branch.closed':
        closeBranch(ev.branch, ev.ts, '')
        break
    }
  }
  return { work, checkpoints, decisions, branches, contextProposed, consumedContext }
}

/** 事件流 → 回放节点序列(过程节点/检查点/分叉痕;bookkeeping 事件不成为节点) */
export function buildReplayNodes(events: TimelineEvent[]) {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  const nodes = sorted.flatMap<ReplayNode>((ev) => {
    switch (ev.type) {
      case 'work.created':
      case 'note':
      case 'artifact':
      case 'tool':
      case 'context.consumed':
      case 'context.proposed':
        return [{ kind: 'process', id: ev.id, seq: ev.seq, ts: ev.ts, branch: ev.branch, ev }]
      case 'checkpoint.raised':
        return [{ kind: 'checkpoint', id: ev.id, seq: ev.seq, ts: ev.ts, branch: ev.branch, checkpoint: ev.checkpoint }]
      case 'decision.made':
        return ev.branchClosed || ev.branchOpened
          ? [
              {
                kind: 'fork',
                id: ev.id,
                seq: ev.seq,
                ts: ev.ts,
                branch: ev.branch,
                action: ev.decision.action,
                from: ev.branchClosed ?? ev.branch,
                to: ev.branchOpened ?? ev.branch,
                text: ev.decision.text,
              },
            ]
          : []
      default:
        return []
    }
  })
  return nodes
}
