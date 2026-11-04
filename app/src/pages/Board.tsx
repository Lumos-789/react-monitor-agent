import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { RMA_MODE } from '@/api'
import { STATUS_META, TRACK_META, type ContextEntry, type WorkItem, type WorkStatus } from '@/types'
import { Database, Hammer, CircleAlert, ArrowRight, CheckCircle2, Activity, Archive } from 'lucide-react'

/** live 空板引导:与 store.createWork 必填字段逐字对齐(track/kind/title/agent,id 可省) */
const CREATE_FIRST_WORK_CURL = `curl -X POST http://localhost:8790/api/works \\
  -H 'content-type: application/json' \\
  -d '{"track":"work","kind":"coding","title":"我的第一个工程","agent":"my-agent"}'`

/** 等你决策的排最前;健康(active)居中;完工/放弃沉底低亮度 —— 「健康不占空间」= 亮度层级 */
const STATUS_ORDER: Record<WorkStatus, number> = { waiting: 0, active: 1, done: 2, abandoned: 2 }

/** 相对时间:板面回答「谁刚动过」;悬停可见绝对时间 */
function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 10) return '刚刚'
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} 天前`
  const dt = new Date(t)
  const md = `${dt.getFullYear() === new Date().getFullYear() ? '' : `${dt.getFullYear()} 年 `}${dt.getMonth() + 1} 月 ${dt.getDate()} 日`
  return md
}

function StatusBadge({ status }: { status: WorkStatus }) {
  if (status === 'waiting')
    return (
      <Badge className="animate-pulse border-sky-400/60 bg-sky-500/15 px-2.5 py-1 text-sky-300">
        <CircleAlert className="size-3.5" /> {STATUS_META.waiting.label}
      </Badge>
    )
  if (status === 'active')
    return (
      <Badge className="border-white/15 bg-white/5 px-2.5 py-1 text-zinc-400">
        <Activity className="size-3.5" /> {STATUS_META.active.label}
      </Badge>
    )
  if (status === 'done')
    return (
      <Badge className="border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-emerald-400">
        <CheckCircle2 className="size-3.5" /> {STATUS_META.done.label}
      </Badge>
    )
  return (
    <Badge className="border-white/10 px-2.5 py-1 text-zinc-600">
      <Archive className="size-3.5" /> {STATUS_META.abandoned.label}
    </Badge>
  )
}

function WorkCard({ w, onOpen }: { w: WorkItem; onOpen: () => void }) {
  const isContext = w.track === 'context'
  const waiting = w.status === 'waiting'
  const sunk = w.status === 'done' || w.status === 'abandoned'
  return (
    <button
      onClick={onOpen}
      className={cn(
        'group w-full rounded-lg border p-5 text-left transition-all focus-visible:ring-2 focus-visible:ring-sky-400/70 focus-visible:outline-none',
        waiting
          ? 'border-sky-400/55 bg-zinc-900/80 shadow-[0_0_32px_-16px_rgba(14,165,233,0.65)] hover:border-sky-300/80'
          : sunk
            ? 'border-white/5 bg-zinc-900/25 opacity-50 hover:opacity-80'
            : isContext
              ? 'border-violet-500/25 bg-zinc-900/50 hover:border-violet-400/60'
              : 'border-sky-500/25 bg-zinc-900/50 hover:border-sky-400/60',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={cn('min-w-0 flex-1 basis-full truncate text-[16px] font-semibold sm:basis-0', sunk && 'text-zinc-400')}>{w.title}</span>
        <span
          title={`上次更新:${w.updatedAt}`}
          className={cn('shrink-0 font-mono text-[10px]', waiting ? 'text-sky-400/80' : 'text-zinc-600')}
        >
          {relTime(w.updatedAt)}
        </span>
        <span className="shrink-0">
          <StatusBadge status={w.status} />
        </span>
      </div>
      {/* CTA 不依赖 summary:createWork 输入根本没有 summary 字段(store.ts),live 首个工程卡不能连「进入回放」提示都没有 */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {w.summary && <p className="min-w-0 flex-1 basis-full text-sm leading-relaxed text-zinc-400 line-clamp-2 sm:basis-0">{w.summary}</p>}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-sky-400/80 transition-colors group-hover:text-sky-300 group-focus-within:text-sky-300">
          {w.status === 'done' ? '查看完工态' : '进入回放'} <ArrowRight className="size-3.5" />
        </span>
      </div>
    </button>
  )
}

function TrackSection({ track, works, drafts, onOpen }: { track: 'context' | 'work'; works: WorkItem[]; drafts: ContextEntry[]; onOpen: (id: string) => void }) {
  const isContext = track === 'context'
  const sorted = [...works].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt))
  return (
    <section
      className={cn(
        'flex min-h-0 flex-col rounded-lg border p-5',
        isContext ? 'border-violet-500/20 bg-violet-500/[0.045]' : 'border-sky-500/20 bg-sky-500/[0.045]',
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex size-9 items-center justify-center rounded-xl',
            isContext ? 'bg-violet-500/15 text-violet-300' : 'bg-sky-500/15 text-sky-300',
          )}
        >
          {isContext ? <Database className="size-5" /> : <Hammer className="size-5" />}
        </span>
        <div>
          <h2 className="font-display text-base font-bold tracking-wide">{TRACK_META[track].label}</h2>
          <p className="text-xs text-zinc-500">{TRACK_META[track].sub}</p>
        </div>
      </div>
      <div className="mt-5 flex-1 space-y-4">
        {sorted.map((w) => (
          <WorkCard key={w.id} w={w} onOpen={() => onOpen(w.id)} />
        ))}
        {sorted.length === 0 && (
          <div className="rounded-lg border border-dashed border-white/10 px-6 py-8 text-center text-sm text-zinc-600">此轨暂无进行中的工程</div>
        )}
        {isContext && drafts.length > 0 && (
          <div className="rounded-lg border border-violet-500/25 bg-violet-500/[0.06] p-4">
            <p className="mb-3 flex items-center gap-2 text-xs font-bold tracking-widest text-violet-300 uppercase">
              <Database className="size-3.5" /> 待入库
            </p>
            <div className="space-y-2">
              {drafts.map((e) => (
                <div key={e.id} className="flex items-center gap-2.5 text-sm">
                  <span className="size-1.5 shrink-0 rounded-full bg-violet-400/70" />
                  <span className="truncate text-zinc-300">{e.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export function Board({
  works,
  contextDrafts,
  onOpen,
}: {
  works: WorkItem[]
  contextDrafts: ContextEntry[]
  onOpen: (id: string) => void
}) {
  const ctx = works.filter((w) => w.track === 'context')
  const wk = works.filter((w) => w.track === 'work')
  const waitingCount = works.filter((w) => w.status === 'waiting').length
  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h1 className="font-display text-2xl font-bold">操作板</h1>
        {waitingCount > 0 && (
          <Badge className="animate-pulse border-sky-400/60 bg-sky-500/15 px-3 py-1 text-sky-300">
            {waitingCount} 个工程等你决策
          </Badge>
        )}
      </div>
      {works.length === 0 && RMA_MODE === 'live' && (
        <div className="rounded-3xl border border-dashed border-sky-500/30 bg-sky-500/[0.04] p-8">
          <p className="mb-1 font-display text-lg font-bold">操作板还是空的</p>
          <p className="mb-4 text-sm text-zinc-400">rma-core 已连接，但还没有任何工程。任何能 curl 的 agent 都能灌入第一个工程：</p>
          <pre className="mb-4 overflow-x-auto rounded-xl border border-white/10 bg-zinc-950 px-4 py-3 font-mono text-xs leading-relaxed text-zinc-300">
            <code>{CREATE_FIRST_WORK_CURL}</code>
          </pre>
          <p className="text-xs text-zinc-500">创建后 5 秒内会出现在下方轨道；完整驱动序列（inbox 长轮询 / 检查点上报）见 core/README「worker 驱动序列」。</p>
        </div>
      )}
      <div className="grid min-h-0 flex-1 gap-7 lg:grid-cols-2">
        <TrackSection track="context" works={ctx} drafts={contextDrafts} onOpen={onOpen} />
        <TrackSection track="work" works={wk} drafts={[]} onOpen={onOpen} />
      </div>
    </div>
  )
}
