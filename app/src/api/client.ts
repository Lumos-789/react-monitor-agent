/**
 * API 客户端契约面 —— 覆盖 .agents/tech-design.md §2.1 全部 14 个端点。
 * LIVE(真 fetch localhost core)与 FIXTURE(JSONL 重建)各实现一份,board 只见本接口。
 */
import type { ContextEntry, Decision, DecisionAction, Evidence, TimelineEvent, WorkItem, WorkStatus, WorkTrack } from '@/types'
import type { FoldedWork } from './fold'

export interface RmaApiErrorShape {
  code: string
  message: string
}

export class RmaApiError extends Error {
  code: string
  status?: number
  constructor(code: string, message: string, status?: number) {
    super(`${code}: ${message}`)
    this.code = code
    this.status = status
  }
}

export interface HealthInfo {
  version: string
  uptimeMs: number
  works: number
}

export interface WorkFilters {
  track?: WorkTrack
  status?: WorkStatus
}

export interface ContextFilters {
  q?: string
  status?: 'draft' | 'accepted'
}

/** GET /api/works/:workId/timeline 的 board 侧统一形态:原始事件 + 同一 fold 的结果 */
export interface TimelineResponse {
  events: TimelineEvent[]
  folded: FoldedWork
}

export type EventInput =
  | { type: 'note'; text: string; evidence?: Evidence[] }
  | { type: 'artifact'; title: string; evidence: Evidence[] }
  | { type: 'tool'; tool: string; summary: string }
  | { type: 'context.consumed'; entryIds: string[] }
  | { type: 'context.proposed'; entry: ContextEntry }
  | { type: 'work.status'; status: 'abandoned'; reason?: string }

export interface CheckpointInput {
  type: import('@/types').CheckpointType
  origin: 'template' | 'agent'
  title: string
  body: string
  evidence: Evidence[]
}

export interface DecisionInput {
  action: DecisionAction
  text?: string
  attachments?: Evidence[]
}

export interface RmaClient {
  // 1 GET /api/health
  health(): Promise<HealthInfo>
  // 2 POST /api/works
  createWork(input: { id?: string; track: WorkTrack; kind: string; title: string; agent: string; template?: string }): Promise<WorkItem>
  // 3 GET /api/works
  listWorks(filters?: WorkFilters): Promise<WorkItem[]>
  // 4 GET /api/works/:workId
  getWork(workId: string): Promise<WorkItem & { openCheckpointId?: string }>
  // 5 GET /api/works/:workId/timeline(?sinceSeq=N)
  getTimeline(workId: string, sinceSeq?: number): Promise<TimelineResponse>
  // 6 POST /api/works/:workId/events
  postEvent(workId: string, ev: EventInput): Promise<TimelineEvent>
  // 7 POST /api/works/:workId/checkpoints
  postCheckpoint(workId: string, cp: CheckpointInput): Promise<import('@/types').Checkpoint>
  // 8 POST /api/checkpoints/:checkpointId/decisions —— board 按钮组唯一出口
  postDecision(workId: string, checkpointId: string, input: DecisionInput): Promise<Decision>
  // 9 GET /api/works/:workId/inbox(?wait=N)
  getInbox(workId: string, wait?: number): Promise<Decision[]>
  // 10 POST /api/decisions/:decisionId/ack
  ackDecision(workId: string, decisionId: string): Promise<void>
  // 11 GET /api/works/:workId/evidence/:fileId —— 取回证据文件的 URL(浏览器直访)
  evidenceUrl(workId: string, fileId: string): string
  // 12 POST /api/context
  postContext(entry: Omit<ContextEntry, 'status' | 'createdAt' | 'updatedAt'>): Promise<ContextEntry>
  // 13 GET /api/context
  listContext(filters?: ContextFilters): Promise<ContextEntry[]>
  // 14 GET /api/context/:entryId
  getContext(entryId: string): Promise<ContextEntry>
}
