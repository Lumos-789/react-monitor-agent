import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { rma, RMA_MODE } from '@/api'
import { Board } from './Board'
import type { ContextEntry, WorkItem } from '@/types'
import { cn } from '@/lib/utils'
import { CircleAlert, RefreshCw } from 'lucide-react'

export default function Home() {
  const navigate = useNavigate()
  const [works, setWorks] = useState<WorkItem[] | null>(null)
  const [drafts, setDrafts] = useState<ContextEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const [ws, ctx] = await Promise.all([rma.listWorks(), rma.listContext({ status: 'draft' })])
      setWorks(ws)
      setDrafts(ctx)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // 后台 tab 不轮询(省 core 负载/电量,fixture 模式也停掉无谓重渲染);回前台立即刷新,不用盲等下一拍
  useEffect(() => {
    void load()
    const t = setInterval(() => {
      if (!document.hidden) void load()
    }, 5000)
    const onVisible = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  // 手动刷新在途可见并防连点;轮询/回前台的自动刷新不打扰(不转圈不闪)
  const manualRefresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }, [load, refreshing])

  // 断连不清板:首载失败才整屏;已有数据时保旧数据+细横幅,轮询/回前台自动重试自愈
  if (error && !works) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <div className="rounded-2xl border border-rose-500/40 bg-rose-500/5 p-6">
          <p className="mb-2 font-mono text-xs tracking-widest text-rose-300 uppercase">操作板加载失败</p>
          <p className="mb-4 text-sm break-all text-zinc-300">{error}</p>
          {RMA_MODE === 'live' && (
            <p className="mb-4 text-sm text-zinc-400">
              若还没启动 rma-core：先在 core/ 目录跑 <code className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs text-zinc-300">npm run dev</code>（默认端口 8790），起来后再重试。
            </p>
          )}
          <button onClick={() => void load()} className="text-sm text-sky-400 hover:text-sky-300">重试</button>
        </div>
      </div>
    )
  }
  if (!works) return <div className="p-10 font-mono text-sm text-zinc-500">正在加载操作板…</div>

  return (
    <div className="relative flex h-[calc(100vh-53px)] flex-col p-4 sm:p-8">
      {error && (
        <div
          role="alert"
          className="mb-4 flex shrink-0 items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 pr-20 text-sm text-amber-300"
        >
          <CircleAlert className="size-4 shrink-0" />
          连接已断开，正在显示上次数据；每 5 秒自动重试，恢复后自动更新。
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Board
          works={works}
          contextDrafts={drafts}
          onOpen={(id) => {
            const w = works.find((x) => x.id === id)
            navigate(w?.status === 'done' ? `/work/${id}/done` : `/work/${id}`)
          }}
        />
      </div>
      <button
        onClick={() => void manualRefresh()}
        title="刷新"
        aria-label="刷新"
        disabled={refreshing}
        className="absolute top-4 right-4 flex size-8 items-center justify-center rounded-lg border border-white/10 bg-zinc-950/70 text-zinc-500 backdrop-blur transition-colors hover:border-sky-500/40 hover:text-sky-300 disabled:pointer-events-none disabled:opacity-60 sm:top-8 sm:right-8 sm:size-9"
      >
        <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
      </button>
    </div>
  )
}
