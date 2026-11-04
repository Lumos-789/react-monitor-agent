// Event model — verbatim contract from .agents/tech-design.md §1 (single source of truth).

/** 检查点四类型(design.md §3.2;类型决定动作子集) */
export type CheckpointType = 'plan' | 'progress' | 'risk' | 'delivery';

/** 动作五元(design.md §3.1) */
export type DecisionAction = 'approve' | 'reject' | 'redirect' | 'supplement' | 'deliver';

/** 检查点类型 × 允许动作矩阵(core 强校验,越界 400 INVALID_ACTION) */
export const ALLOWED_ACTIONS: Record<CheckpointType, DecisionAction[]> = {
  plan: ['approve', 'reject', 'redirect', 'supplement'],
  progress: ['approve', 'redirect', 'supplement'],
  risk: ['approve', 'reject', 'supplement'],
  delivery: ['deliver', 'reject', 'supplement'],
};

export const CHECKPOINT_TYPES: readonly CheckpointType[] = ['plan', 'progress', 'risk', 'delivery'];
export const DECISION_ACTIONS: readonly DecisionAction[] = ['approve', 'reject', 'redirect', 'supplement', 'deliver'];

/** 双轨(design.md §2.1) */
export type WorkTrack = 'context' | 'work';

/** Work 状态机:waiting=有 open 检查点在人侧等待 */
export type WorkStatus = 'active' | 'waiting' | 'done' | 'abandoned';

export const WORK_TRACKS: readonly WorkTrack[] = ['context', 'work'];
export const WORK_STATUSES: readonly WorkStatus[] = ['active', 'waiting', 'done', 'abandoned'];

/** 证据(检查点正文与过程事件的附件) */
export type Evidence =
  | { kind: 'text'; text: string }
  | { kind: 'code_diff'; text: string }
  | { kind: 'link'; url: string; caption?: string }
  | { kind: 'image' | 'file'; path: string; url: string; caption?: string };

/** 上报输入形态(dataB64 → core 落盘后归一化为 path+url 写进事件) */
export type EvidenceInput =
  | { kind: 'text'; text: string }
  | { kind: 'code_diff'; text: string }
  | { kind: 'link'; url: string; caption?: string }
  | { kind: 'image' | 'file'; dataB64: string; filename?: string; caption?: string }
  | { kind: 'image' | 'file'; path: string; url: string; caption?: string };

/** Work(工程) */
export interface WorkItem {
  id: string;
  track: WorkTrack;
  kind: string;
  title: string;
  agent: string;
  status: WorkStatus;
  activeBranch: string;
  template?: string;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  summary?: string;
}

/** Checkpoint(工序验收点) */
export interface Checkpoint {
  id: string;
  workId: string;
  type: CheckpointType;
  origin: 'template' | 'agent';
  title: string;
  body: string;
  evidence: Evidence[];
  raisedAt: string;
  raisedBy: string;
  status: 'open' | 'resolved' | 'expired';
  resolvedByDecisionId?: string;
  resolvedAt?: string;
  outcome?: {
    action: DecisionAction;
    branchClosed?: string;
    branchOpened?: string;
  };
}

/** Decision(人的结构化反馈) */
export interface Decision {
  id: string;
  workId: string;
  checkpointId: string;
  action: DecisionAction;
  text?: string;
  attachments?: Evidence[];
  actor: string;
  createdAt: string;
  consumedAt?: string | null;
}

/** Context Track 条目(入库知识) */
export interface ContextEntry {
  id: string;
  title: string;
  kind: string;
  tags: string[];
  content: string;
  status: 'draft' | 'accepted';
  sourceWorkId?: string;
  createdAt: string;
  updatedAt: string;
}

/** TimelineEvent(时间线事件,append-only 日志的一行) */
interface TimelineEventBase {
  id: string;
  workId: string;
  seq: number;
  ts: string;
  branch: string;
  actor: string;
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
      type: 'decision.made';
      decision: Decision;
      branchClosed?: string;
      branchOpened?: string;
    })
  | (TimelineEventBase & { type: 'decision.acked'; decisionId: string })
  | (TimelineEventBase & { type: 'branch.closed'; branch: string; reason: string });

export interface BranchInfo {
  id: string;
  openedAt: string;
  closedAt?: string;
  closedByDecisionId?: string;
  status: 'active' | 'closed';
}
