/**
 * 模式切换 —— VITE_RMA_MODE=live|fixture,默认 FIXTURE(离线可演示)。
 */
import type { RmaClient } from './client'
import { fixtureClient } from './fixture'
import { liveClient } from './live'

export type RmaMode = 'fixture' | 'live'

export const RMA_MODE: RmaMode = import.meta.env.VITE_RMA_MODE === 'live' ? 'live' : 'fixture'

export type Rma = RmaClient & { resetSession?: (workId: string) => void }

export const rma: Rma = RMA_MODE === 'live' ? liveClient : fixtureClient

export { RmaApiError } from './client'
export type { TimelineResponse, HealthInfo, RmaClient } from './client'
export { foldWorkEvents, buildReplayNodes } from './fold'
export type { FoldedWork } from './fold'
