/**
 * 契约类型层 —— 与 .agents/tech-design.md §1 逐条对齐(契约为准)。
 * board 侧单一类型事实源:src/api 全部从这里取,不另立副本。
 */

// ── 枚举与字面量 ──────────────────────────────────────────────

/** 检查点四类型(design.md §3.2;类型决定动作子集) */
export type CheckpointType = 'plan' | 'progress' | 'risk' | 'delivery'

/** 动作五元(design.md §3.1) */
export type DecisionAction = 'approve' | 'reject' | 'redirect' | 'supplement' | 'deliver'

/** 检查点类型 × 允许动作矩阵(core 强校验;board 同源引用,不另写子集) */
export const ALLOWED_ACTIONS: Record<CheckpointType, DecisionAction[]> = {
  plan: ['approve', 'reject', 'redirect', 'supplement'],
  progress: ['approve', 'redirect', 'supplement'],
  risk: ['approve', 'reject', 'supplement'],
  delivery: ['deliver', 'reject', 'supplement'],
}

/** 双轨(design.md §2.1) */
export type WorkTrack = 'context' | 'work'

/** Work 状态机:waiting=有 open 检查点在人侧等待 */
export type WorkStatus = 'active' | 'waiting' | 'done' | 'abandoned'

// ── 证据 ─────────────────────────────────────────────────────

export type Evidence =
  | { kind: 'text'; text: string }
  | { kind: 'code_diff'; text: string }
  | { kind: 'link'; url: string; caption?: string }
  | { kind: 'image' | 'file'; path: string; url: string; caption?: string }

// ── Work(工程)──────────────────────────────────────────────

export interface WorkItem {
  id: string
  track: WorkTrack
  kind: string
  title: string
  agent: string
  status: WorkStatus
  activeBranch: string
  template?: string
  createdAt: string
  updatedAt: string
  lastSeq: number
  summary?: string
}

// ── Checkpoint(工序验收点)──────────────────────────────────

export interface Checkpoint {
  id: string
  workId: string
  type: CheckpointType
  origin: 'template' | 'agent'
  title: string
  body: string
  evidence: Evidence[]
  raisedAt: string
  raisedBy: string
  status: 'open' | 'resolved' | 'expired'
  resolvedByDecisionId?: string
  resolvedAt?: string
  outcome?: {
    action: DecisionAction
    branchClosed?: string
    branchOpened?: string
  }
}

// ── Decision(人的结构化反馈)────────────────────────────────

export interface Decision {
  id: string
  workId: string
  checkpointId: string
  action: DecisionAction
  text?: string
  attachments?: Evidence[]
  actor: string
  createdAt: string
  consumedAt?: string | null
}

// ── Context Track 条目 ──────────────────────────────────────

export interface ContextEntry {
  id: string
  title: string
  kind: string
  tags: string[]
  content: string
  status: 'draft' | 'accepted'
  sourceWorkId?: string
  createdAt: string
  updatedAt: string
}

// ── TimelineEvent(append-only 日志的一行)──────────────────

export interface TimelineEventBase {
  id: string
  workId: string
  seq: number
  ts: string
  branch: string
  actor: string
}

export type TimelineEvent =
  | (TimelineEventBase & { type: 'work.created'; work: WorkItem })
  | (TimelineEventBase & { type: 'work.status'; status: WorkStatus; reason?: string })
  | (TimelineEventBase & { type: 'note'; text: string; evidence?: Evidence[] })
  | (TimelineEventBase & { type: 'artifact'; title: string; evidence: Evidence[] })
  | (TimelineEventBase & { type: 'tool'; tool: string; summary: string })
  | (TimelineEventBase & { type: 'context.consumed'; entryIds: string[] })
  | (TimelineEventBase & { type: 'context.proposed'; entry: ContextEntry })
  | (TimelineEventBase & { type: 'checkpoint.raised'; checkpoint: Checkpoint })
  | (TimelineEventBase & {
      type: 'decision.made'
      decision: Decision
      branchClosed?: string
      branchOpened?: string
    })
  | (TimelineEventBase & { type: 'decision.acked'; decisionId: string })
  | (TimelineEventBase & { type: 'branch.closed'; branch: string; reason: string })

export interface BranchInfo {
  id: string
  openedAt: string
  closedAt?: string
  closedByDecisionId?: string
  status: 'active' | 'closed'
}

// ── UI 展示元数据(design.md §3/§5 冻结)────────────────────

export const ACTION_LABEL: Record<DecisionAction, string> = {
  approve: '批准',
  reject: '否定',
  redirect: '改向',
  supplement: '补充',
  deliver: '完工',
}

export const CP_META: Record<CheckpointType, { label: string; char: string; hint: string }> = {
  plan: { label: '方案', char: '方', hint: 'agent 提出方案,等你拍板' },
  progress: { label: '阶段', char: '阶', hint: '里程碑成果展示' },
  risk: { label: '风险', char: '风', hint: 'agent 自报拿不准' },
  delivery: { label: '完工', char: '完', hint: '交付物最终审查' },
}

export const TRACK_META: Record<WorkTrack, { label: string; sub: string }> = {
  context: { label: '上下文建设', sub: '非业务产出 · 养弹药' },
  work: { label: '业务执行', sub: 'coding 及一切真业务' },
}

export const STATUS_META: Record<WorkStatus, { label: string }> = {
  active: { label: '推进中' },
  waiting: { label: '等你决策' },
  done: { label: '已完工' },
  abandoned: { label: '已放弃' },
}

/** 语义约定:approve/reject/redirect/deliver 解决检查点;supplement 只注入材料不解决 */
export function isResolvingAction(a: DecisionAction): boolean {
  return a !== 'supplement'
}

// ── 回放视图模型(board 由事件流推导,不落契约)──────────────

export type ReplayNode =
  | {
      kind: 'process'
      id: string
      seq: number
      ts: string
      branch: string
      ev: Extract<TimelineEvent, { type: 'note' | 'artifact' | 'tool' | 'context.consumed' | 'context.proposed' | 'work.created' }>
    }
  | { kind: 'checkpoint'; id: string; seq: number; ts: string; branch: string; checkpoint: Checkpoint }
  | {
      kind: 'fork'
      id: string
      seq: number
      ts: string
      branch: string
      action: DecisionAction
      from: string
      to: string
      text?: string
    }

export type NodeStatus = 'pending' | 'active' | 'done' | 'rejected'
