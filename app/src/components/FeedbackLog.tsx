import { ACTION_LABEL, type Checkpoint, type Decision } from '@/types'
import { cn } from '@/lib/utils'
import { Check, X, CornerUpRight, MessageSquarePlus, Flag } from 'lucide-react'

const ICONS = { approve: Check, reject: X, redirect: CornerUpRight, supplement: MessageSquarePlus, deliver: Flag }
const CLS = {
  approve: 'text-emerald-400 border-emerald-500/30',
  reject: 'text-rose-400 border-rose-500/30',
  redirect: 'text-sky-400 border-sky-500/30',
  supplement: 'text-violet-400 border-violet-500/30',
  deliver: 'text-emerald-300 border-emerald-400/40',
}

/** 右侧窄反馈流:决策即落库即所见(design.md §5) */
export function FeedbackLog({ decisions, checkpoints }: { decisions: Decision[]; checkpoints: Checkpoint[] }) {
  return (
    <div className="flex h-full flex-col">
      <p className="mb-3 shrink-0 font-mono text-[10px] tracking-widest text-zinc-500 uppercase">决策记录</p>
      <div className="flex-1 space-y-2 overflow-y-auto pr-1">
        {decisions.length === 0 && <p className="text-xs leading-relaxed text-zinc-600">你的决策会落库并回注给 agent。</p>}
        {decisions.map((d) => {
          const Icon = ICONS[d.action]
          const cp = checkpoints.find((c) => c.id === d.checkpointId)
          return (
            <div key={d.id} className={cn('rounded-xl border bg-zinc-900/60 px-3 py-2.5', CLS[d.action])}>
              <div className="flex items-center gap-2">
                <Icon className="size-3.5 shrink-0" />
                <span className="text-xs font-semibold">{ACTION_LABEL[d.action]}</span>
              </div>
              {cp && <p className="mt-1 line-clamp-2 text-[11px] text-zinc-400">@ {cp.title}</p>}
              {d.text && <p className="mt-1 rounded-lg bg-white/5 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-300">「{d.text}」</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
