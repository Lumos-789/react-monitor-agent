/**
 * LIVE 模式 —— 真 fetch localhost core(契约 §2:http://127.0.0.1:8790/api,信封 {ok,data}/{ok,error})。
 */
import type { Checkpoint, Decision, TimelineEvent } from '@/types'
import { RmaApiError, type CheckpointInput, type DecisionInput, type EventInput, type RmaClient, type TimelineResponse } from './client'
import { foldWorkEvents } from './fold'

export const LIVE_BASE: string = import.meta.env.VITE_RMA_API_BASE ?? 'http://127.0.0.1:8790/api'

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${LIVE_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch (e) {
    throw new RmaApiError('NETWORK', `无法连接 rma-core(${LIVE_BASE}):${e instanceof Error ? e.message : String(e)}`)
  }
  let body: Envelope<T>
  try {
    body = (await res.json()) as Envelope<T>
  } catch {
    throw new RmaApiError('INTERNAL', `core 响应不是 JSON(HTTP ${res.status})`, res.status)
  }
  if (!res.ok || !body.ok) {
    throw new RmaApiError(body.error?.code ?? 'INTERNAL', body.error?.message ?? `HTTP ${res.status}`, res.status)
  }
  return body.data as T
}

export const liveClient: RmaClient = {
  health: () => req('/health'),
  createWork: (input) => req('/works', { method: 'POST', body: JSON.stringify(input) }),
  listWorks: (filters) => {
    const q = new URLSearchParams()
    if (filters?.track) q.set('track', filters.track)
    if (filters?.status) q.set('status', filters.status)
    const s = q.toString()
    return req(`/works${s ? `?${s}` : ''}`)
  },
  getWork: (workId) => req(`/works/${workId}`),
  getTimeline: async (workId, sinceSeq) => {
    const q = sinceSeq !== undefined ? `?sinceSeq=${sinceSeq}` : ''
    // 契约端点返回原始事件 + core fold 的投影;board 用同一 fold 重放原始事件,两侧同源
    const data = await req<{ events: TimelineEvent[] }>(`/works/${workId}/timeline${q}`)
    const events = data.events ?? (data as unknown as TimelineEvent[])
    return { events, folded: foldWorkEvents(events) } as TimelineResponse
  },
  postEvent: (workId, ev: EventInput) => req(`/works/${workId}/events`, { method: 'POST', body: JSON.stringify(ev) }),
  postCheckpoint: (workId, cp: CheckpointInput) => req<Checkpoint>(`/works/${workId}/checkpoints`, { method: 'POST', body: JSON.stringify(cp) }),
  postDecision: (workId, checkpointId, input: DecisionInput) =>
    req<Decision>(`/checkpoints/${checkpointId}/decisions`, { method: 'POST', body: JSON.stringify(input) }),
  getInbox: (workId, wait) => req<{ decisions: Decision[] }>(`/works/${workId}/inbox${wait ? `?wait=${wait}` : ''}`).then((d) => d.decisions),
  ackDecision: (workId, decisionId) => {
    void req(`/decisions/${decisionId}/ack`, { method: 'POST' })
    return Promise.resolve()
  },
  evidenceUrl: (workId, fileId) => `${LIVE_BASE}/works/${workId}/evidence/${fileId}`,
  postContext: (entry) => req('/context', { method: 'POST', body: JSON.stringify(entry) }),
  listContext: (filters) => {
    const q = new URLSearchParams()
    if (filters?.q) q.set('q', filters.q)
    if (filters?.status) q.set('status', filters.status)
    const s = q.toString()
    return req(`/context${s ? `?${s}` : ''}`)
  },
  getContext: (entryId) => req(`/context/${entryId}`),
}
