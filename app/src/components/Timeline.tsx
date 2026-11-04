import { useEffect, useRef } from 'react'
import { ACTION_LABEL, CP_META, type DecisionAction, type NodeStatus, type ReplayNode } from '@/types'
import { cn } from '@/lib/utils'

const CP_COLOR = {
  plan: 'text-sky-400 border-sky-500/50 bg-sky-500/10',
  progress: 'text-cyan-300 border-cyan-500/50 bg-cyan-500/10',
  risk: 'text-amber-400 border-amber-500/50 bg-amber-500/10',
  delivery: 'text-emerald-400 border-emerald-500/50 bg-emerald-500/10',
} as const

const STATUS_STYLE = {
  pending: 'border-white/15 text-zinc-500',
  active: 'border-sky-400 text-sky-300 ring-2 ring-sky-500/30',
  done: 'border-white/30 text-zinc-300',
  rejected: 'border-white/10 text-zinc-600 opacity-45',
} as const

/** 已决策检查点角标:动作色小点(动作色=后果色) */
const ACTION_DOT: Record<DecisionAction, string> = {
  approve: 'bg-emerald-400',
  reject: 'bg-rose-400',
  redirect: 'bg-sky-400',
  supplement: 'bg-violet-400',
  deliver: 'bg-emerald-300',
}

function nodeTitle(p: ReplayNode): string {
  if (p.kind === 'checkpoint') return p.checkpoint.title
  if (p.kind === 'fork') return `${ACTION_LABEL[p.action]} · ${p.from} → ${p.to}`
  switch (p.ev.type) {
    case 'work.created':
      return '工程立项'
    case 'context.consumed':
      return '消费上下文'
    case 'context.proposed':
      return '蒸馏回提'
    case 'note':
      return '过程叙事'
    case 'artifact':
      return p.ev.title
    case 'tool':
      return p.ev.tool
  }
}

export function Timeline({
  nodes,
  statuses,
  activeIndex,
  progress,
  onSeek,
}: {
  nodes: ReplayNode[]
  statuses: Record<string, NodeStatus>
  activeIndex: number
  progress: number
  onSeek: (index: number) => void
}) {
  // 长回放横向溢出时当前节点保持在视野内:跳检查点/步进/自动播放推进都跟随(nearest 只补足缺口,不打扰已可见时的手动滚动)
  const activeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeIndex])

  return (
    <div className="px-1 pt-2 pb-1">
      <div className="flex items-center gap-0 overflow-x-auto pb-2">
        {nodes.map((n, i) => {
          const st = statuses[n.id] ?? 'pending'
          const prev = nodes[i - 1]
          const prevSt = prev ? (statuses[prev.id] ?? 'pending') : null
          const isAltBranch = n.branch !== 'main'
          return (
            <div key={n.id} className="flex items-center">
              {i > 0 && (
                <div
                  className={cn(
                    'h-px w-7 shrink-0',
                    st === 'rejected' || prevSt === 'rejected' ? 'bg-white/5' : prevSt === 'done' ? 'bg-sky-500/40' : 'bg-white/15',
                  )}
                />
              )}
              <button
                onClick={() => onSeek(i)}
                ref={st === 'active' ? activeRef : undefined}
                className="group flex shrink-0 flex-col items-center gap-1.5"
                title={nodeTitle(n)}
                aria-label={`节点 ${i + 1}: ${nodeTitle(n)}`}
              >
                {n.kind === 'checkpoint' ? (
                  <span className="relative flex">
                    <span
                      className={cn(
                        'flex size-8 items-center justify-center rounded-lg border font-mono text-[11px] font-bold transition-all',
                        CP_COLOR[n.checkpoint.type],
                        st === 'active' && 'scale-110 ring-2 ring-offset-2 ring-offset-zinc-950',
                        st === 'rejected' && 'grayscale',
                        st === 'done' && 'opacity-70',
                      )}
                    >
                      {CP_META[n.checkpoint.type].char}
                    </span>
                    {n.checkpoint.status === 'resolved' && n.checkpoint.outcome && (
                      <span className={cn('absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-zinc-950', ACTION_DOT[n.checkpoint.outcome.action])} />
                    )}
                  </span>
                ) : n.kind === 'fork' ? (
                  <span
                    className={cn(
                      'flex size-4 rotate-45 items-center justify-center rounded-[3px] border border-sky-400/70 bg-sky-500/20 transition-all',
                      st === 'active' && 'scale-125 ring-2 ring-sky-500/40',
                      st === 'rejected' && 'opacity-40 grayscale',
                    )}
                  />
                ) : (
                  <span
                    className={cn(
                      'size-3 rounded-full border-2 transition-all',
                      STATUS_STYLE[st],
                      isAltBranch && 'rotate-45 rounded-[2px]',
                      st === 'active' && isAltBranch && 'size-3.5',
                    )}
                  />
                )}
                <span
                  className={cn(
                    'max-w-[76px] truncate text-[10px]',
                    st === 'active' ? 'text-sky-300' : st === 'rejected' ? 'text-zinc-600' : 'text-zinc-500',
                    isAltBranch && 'italic',
                  )}
                >
                  {nodeTitle(n)}
                </span>
              </button>
            </div>
          )
        })}
        {/* 终点 */}
        <div className="flex items-center">
          <div className={cn('h-px w-7 shrink-0', activeIndex >= nodes.length ? 'bg-sky-500/40' : 'bg-white/15')} />
          <span className={cn('size-2 rounded-full', activeIndex >= nodes.length ? 'bg-sky-400' : 'bg-white/15')} title="终点" />
        </div>
      </div>
      {/* 播放器进度条:读屏可感知播放进度 */}
      <div
        role="progressbar"
        aria-label="回放进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-white/5"
      >
        <div className="h-full rounded-full bg-gradient-to-r from-sky-500 to-cyan-400" style={{ width: `${Math.min(100, progress * 100)}%` }} />
      </div>
    </div>
  )
}
