/**
 * FIXTURE 模式 —— 读仓库 demo fixture JSONL,内存重建时间线(契约 §5)。
 * 会话从「第一个 decision.made 之前」开演:检查点逐个待人决策;
 * 决策与 fixture 记录一致 → 沿记录继续;分叉 → 旧分支灰掉留痕 + 插入新分支演示节点。
 * 只读 + 内存 overlay,刷新即重置。
 */
import {
  ALLOWED_ACTIONS,
  isResolvingAction,
  type BranchInfo,
  type Checkpoint,
  type CheckpointType,
  type ContextEntry,
  type Decision,
  type Evidence,
  type TimelineEvent,
  type WorkItem,
} from '@/types'
import { RmaApiError, type CheckpointInput, type DecisionInput, type HealthInfo, type RmaClient, type TimelineResponse } from './client'
import { foldWorkEvents } from './fold'
import fixtureRaw from '../../../fixtures/demo-fixture.jsonl?raw'

function parseFixture(raw: string): TimelineEvent[] {
  const out: TimelineEvent[] = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s) as TimelineEvent)
    } catch (e) {
      throw new Error(`fixture JSONL 解析失败: ${s.slice(0, 80)}… (${e instanceof Error ? e.message : e})`)
    }
  }
  return out
}

const RECORDED: TimelineEvent[] = parseFixture(fixtureRaw)

function groupByWork(events: TimelineEvent[]): Map<string, TimelineEvent[]> {
  const m = new Map<string, TimelineEvent[]>()
  for (const ev of events) {
    const list = m.get(ev.workId) ?? []
    list.push(ev)
    m.set(ev.workId, list)
  }
  return m
}

const RECORDED_BY_WORK = groupByWork(RECORDED)

/** 初始 cut:第一个 decision.made 之前 —— 会话开演时 work 停在第一个 open 检查点上 */
function initialCut(recorded: TimelineEvent[]): number {
  const idx = recorded.findIndex((e) => e.type === 'decision.made')
  return idx === -1 ? recorded.length : idx
}

interface FixtureSession {
  events: TimelineEvent[]
  /** recorded 中下一个未收编事件的游标(始终停在一个 decision.made 边界上) */
  recCursor: number
  synthSeq: number
  synthN: number
}

function newSession(recorded: TimelineEvent[]): FixtureSession {
  const cut = initialCut(recorded)
  return {
    events: recorded.slice(0, cut).map((e) => structuredClone(e)),
    recCursor: cut,
    synthSeq: recorded.reduce((m, e) => Math.max(m, e.seq), 0),
    synthN: 0,
  }
}

const sessions = new Map<string, FixtureSession>()
const standaloneContext: ContextEntry[] = []
const startTime = Date.now()

function sessionOf(workId: string): FixtureSession {
  let s = sessions.get(workId)
  if (!s) {
    const recorded = RECORDED_BY_WORK.get(workId)
    if (!recorded) throw new RmaApiError('NOT_FOUND', `work 不存在: ${workId}`)
    s = newSession(recorded)
    sessions.set(workId, s)
  }
  return s
}

function nextSeq(s: FixtureSession): number {
  return ++s.synthSeq
}

function nowIso(): string {
  return new Date().toISOString()
}

function pushEvent(s: FixtureSession, ev: TimelineEvent): void {
  s.events.push(ev)
}

/** 当前活跃分支号 +1(b2、b3…与 fixture 记录的命名习惯一致) */
function nextBranchId(s: FixtureSession, foldedBranches: BranchInfo[]): string {
  void s
  let max = 1
  for (const b of foldedBranches) {
    const m = /^b(\d+)$/.exec(b.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `b${max + 1}`
}

function baseEvent(s: FixtureSession, workId: string, branch: string, actor: string): { id: string; workId: string; seq: number; ts: string; branch: string; actor: string } {
  const seq = nextSeq(s)
  return { id: `ev-${workId}-${seq}`, workId, seq, ts: nowIso(), branch, actor }
}

export const fixtureClient: RmaClient & { resetSession: (workId: string) => void } = {
  health: async (): Promise<HealthInfo> => ({
    version: 'fixture-offline',
    uptimeMs: Date.now() - startTime,
    works: RECORDED_BY_WORK.size,
  }),

  createWork: async (input) => {
    const id = input.id ?? `w-${Math.random().toString(36).slice(2, 8)}`
    if (sessions.has(id) || RECORDED_BY_WORK.has(id)) {
      const folded = foldWorkEvents(sessionOf(id).events)
      const w = folded.work
      const same = w.track === input.track && w.kind === input.kind && w.title === input.title && w.agent === input.agent
      if (!same) throw new RmaApiError('ID_EXISTS', `work 已存在且参数不一致: ${id}`)
      return w
    }
    const ts = nowIso()
    const work: WorkItem = {
      id,
      track: input.track,
      kind: input.kind,
      title: input.title,
      agent: input.agent,
      status: 'active',
      activeBranch: 'main',
      template: input.template,
      createdAt: ts,
      updatedAt: ts,
      lastSeq: 1,
    }
    const s: FixtureSession = { events: [], recCursor: 0, synthSeq: 1, synthN: 0 }
    pushEvent(s, { ...baseEvent(s, id, 'main', `agent:${input.agent}`), type: 'work.created', work })
    sessions.set(id, s)
    return work
  },

  listWorks: async (filters) => {
    const ids = new Set([...RECORDED_BY_WORK.keys(), ...sessions.keys()])
    const works = [...ids].map((id) => foldWorkEvents(sessionOf(id).events).work)
    return works
      .filter((w) => (!filters?.track || w.track === filters.track) && (!filters?.status || w.status === filters.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  },

  getWork: async (workId) => {
    const folded = foldWorkEvents(sessionOf(workId).events)
    const open = folded.checkpoints.find((c) => c.status === 'open')
    return { ...folded.work, openCheckpointId: open?.id }
  },

  getTimeline: async (workId, sinceSeq): Promise<TimelineResponse> => {
    const s = sessionOf(workId)
    const folded = foldWorkEvents(s.events)
    const events = sinceSeq === undefined ? s.events : s.events.filter((e) => e.seq > sinceSeq)
    return { events, folded }
  },

  postEvent: async (workId, input) => {
    const s = sessionOf(workId)
    const folded = foldWorkEvents(s.events)
    const branch = folded.work.activeBranch
    const base = baseEvent(s, workId, branch, 'agent:fixture')
    let ev: TimelineEvent
    switch (input.type) {
      case 'note':
        ev = { ...base, type: 'note', text: input.text, evidence: input.evidence }
        break
      case 'artifact':
        ev = { ...base, type: 'artifact', title: input.title, evidence: input.evidence }
        break
      case 'tool':
        ev = { ...base, type: 'tool', tool: input.tool, summary: input.summary }
        break
      case 'context.consumed':
        ev = { ...base, type: 'context.consumed', entryIds: input.entryIds }
        break
      case 'context.proposed':
        ev = { ...base, type: 'context.proposed', entry: input.entry }
        break
      case 'work.status':
        ev = { ...base, type: 'work.status', status: 'abandoned', reason: input.reason }
        break
    }
    pushEvent(s, ev)
    return ev
  },

  postCheckpoint: async (workId, input: CheckpointInput): Promise<Checkpoint> => {
    const s = sessionOf(workId)
    const folded = foldWorkEvents(s.events)
    if (folded.checkpoints.some((c) => c.status === 'open')) {
      throw new RmaApiError('CHECKPOINT_OPEN', '该 work 已有 open 检查点(一次一个结构化问题)')
    }
    const branch = folded.work.activeBranch
    const ts = nowIso()
    const raiseSeq = nextSeq(s)
    const cp: Checkpoint = {
      id: `cp-${workId}-${raiseSeq}`,
      workId,
      type: input.type as CheckpointType,
      origin: input.origin,
      title: input.title,
      body: input.body,
      evidence: input.evidence as Evidence[],
      raisedAt: ts,
      raisedBy: 'fixture-agent',
      status: 'open',
    }
    pushEvent(s, { ...baseEvent(s, workId, branch, 'agent:fixture'), type: 'checkpoint.raised', checkpoint: cp })
    pushEvent(s, { ...baseEvent(s, workId, branch, 'core'), type: 'work.status', status: 'waiting', reason: `checkpoint ${cp.id} open` })
    return cp
  },

  postDecision: async (workId, checkpointId, input: DecisionInput): Promise<Decision> => {
    const s = sessionOf(workId)
    const recorded = RECORDED_BY_WORK.get(workId) ?? []
    const folded = foldWorkEvents(s.events)

    const cp = folded.checkpoints.find((c) => c.id === checkpointId)
    if (!cp) throw new RmaApiError('NOT_FOUND', `检查点不存在: ${checkpointId}`)
    if (cp.status !== 'open') throw new RmaApiError('ALREADY_RESOLVED', `检查点已 ${cp.status}: ${checkpointId}`)
    if (!ALLOWED_ACTIONS[cp.type].includes(input.action)) {
      throw new RmaApiError('INVALID_ACTION', `动作 ${input.action} 不属 ${cp.type} 检查点子集`)
    }
    if (input.action === 'redirect' && !input.text?.trim()) {
      throw new RmaApiError('INVALID_ACTION', 'redirect 必须携带新方向文本')
    }

    const next = recorded[s.recCursor]
    const matchesRecording =
      next !== undefined && next.type === 'decision.made' && next.decision.checkpointId === checkpointId && next.decision.action === input.action

    if (matchesRecording && next.type === 'decision.made') {
      // 沿记录路线继续:收编 recorded 从当前决策到下一个决策边界之前的全部事件(回注 ack/状态翻转/过程节点)
      const merged: Decision = { ...next.decision, text: input.text?.trim() || next.decision.text, consumedAt: null }
      pushEvent(s, { ...structuredClone(next), decision: merged })
      let k = s.recCursor + 1
      while (k < recorded.length && recorded[k].type !== 'decision.made') {
        pushEvent(s, structuredClone(recorded[k]))
        k++
      }
      s.recCursor = k
      return merged
    }

    // 分叉:与记录不一致(或记录已尽)→ 合成分支弧,旧分支灰掉留痕
    const branch = folded.work.activeBranch
    const openNew = input.action === 'reject' || input.action === 'redirect'
    const newBranch = openNew ? nextBranchId(s, folded.branches) : branch
    const decId = `dec-${workId}-s${++s.synthN}`
    const dec: Decision = {
      id: decId,
      workId,
      checkpointId,
      action: input.action,
      text: input.text?.trim() || undefined,
      actor: 'human',
      createdAt: nowIso(),
      consumedAt: null,
    }
    pushEvent(s, {
      ...baseEvent(s, workId, branch, 'human'),
      type: 'decision.made',
      decision: dec,
      ...(openNew ? { branchClosed: branch, branchOpened: newBranch } : {}),
    })
    const shortText = (t: string) => (t.length > 60 ? `${t.slice(0, 60)}…` : t)
    const textQ = dec.text ? `「${shortText(dec.text)}」` : ''
    const notes: string[] =
      input.action === 'reject'
        ? [`收到否定:${textQ}当前路线叫停,旧分支 ${branch} 关闭留痕。`, 'agent 重估方向,将在新分支重提方案(演示分叉:真实场景由 agent 继续上报事件)。']
        : input.action === 'redirect'
          ? [`收到改向:${textQ}旧分支 ${branch} 关闭留痕。`, `新分支 ${newBranch} 启动:按新方向重排计划(演示分叉:真实场景由 agent 继续上报事件)。`]
          : input.action === 'approve'
            ? [`收到批准:${textQ}按当前方案继续推进。`, 'agent 沿本分支推进(演示分叉:真实场景由 agent 继续上报事件)。']
            : input.action === 'deliver'
              ? ['交付收货,Work 关闭。']
              : []
    const noteBranch = openNew ? newBranch : branch
    for (const text of notes) {
      pushEvent(s, { ...baseEvent(s, workId, noteBranch, 'agent:fixture'), type: 'note', text })
    }
    if (isResolvingAction(input.action)) {
      pushEvent(s, {
        ...baseEvent(s, workId, noteBranch, 'core'),
        type: 'work.status',
        status: input.action === 'deliver' ? 'done' : 'active',
        reason: `checkpoint resolved: ${input.action}`,
      })
    }
    return dec
  },

  getInbox: async (workId) => {
    const folded = foldWorkEvents(sessionOf(workId).events)
    return folded.decisions.filter((d) => !d.consumedAt)
  },

  ackDecision: async (workId, decisionId) => {
    const s = sessionOf(workId)
    const folded = foldWorkEvents(s.events)
    const d = folded.decisions.find((x) => x.id === decisionId)
    if (!d) throw new RmaApiError('NOT_FOUND', `决策不存在: ${decisionId}`)
    if (d.consumedAt) return // 幂等:重复 ack 不重复记事件
    pushEvent(s, { ...baseEvent(s, workId, folded.work.activeBranch, 'agent:fixture'), type: 'decision.acked', decisionId })
  },

  evidenceUrl: () => '#',

  postContext: async (entry) => {
    const ts = nowIso()
    const e: ContextEntry = { ...entry, id: entry.id ?? `ctx-${Math.random().toString(36).slice(2, 8)}`, status: 'draft', createdAt: ts, updatedAt: ts }
    standaloneContext.push(e)
    return e
  },

  listContext: async (filters) => {
    const ids = new Set([...RECORDED_BY_WORK.keys(), ...sessions.keys()])
    const entries: ContextEntry[] = []
    for (const id of ids) entries.push(...foldWorkEvents(sessionOf(id).events).contextProposed)
    entries.push(...standaloneContext)
    const seen = new Set<string>()
    const uniq = entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    const q = filters?.q
    const status = filters?.status
    return uniq
      .filter((e) => (!status || e.status === status) && (!q || e.title.includes(q) || e.tags.some((t) => t.includes(q))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },

  getContext: async (entryId) => {
    const all = await fixtureClient.listContext()
    const e = all.find((x) => x.id === entryId)
    if (!e) throw new RmaApiError('NOT_FOUND', `上下文条目不存在: ${entryId}`)
    return e
  },

  resetSession: (workId) => {
    const recorded = RECORDED_BY_WORK.get(workId)
    if (recorded) sessions.set(workId, newSession(recorded))
  },
}
