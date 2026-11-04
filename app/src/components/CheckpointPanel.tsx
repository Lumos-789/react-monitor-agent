import { useRef, useState } from 'react'
import { ACTION_LABEL, ALLOWED_ACTIONS, CP_META, type Checkpoint, type DecisionAction } from '@/types'
import { cn } from '@/lib/utils'
import { Check, X, CornerUpRight, MessageSquarePlus, Flag, ChevronRight, Loader2 } from 'lucide-react'

/** 动作色=后果色(design.md §5):批准·完工 emerald / 否定 rose / 改向 sky / 补充 violet */
const ACTION_STYLE: Record<DecisionAction, { icon: typeof Check; cls: string }> = {
  approve: { icon: Check, cls: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25' },
  reject: { icon: X, cls: 'border-rose-500/50 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25' },
  redirect: { icon: CornerUpRight, cls: 'border-sky-500/50 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25' },
  supplement: { icon: MessageSquarePlus, cls: 'border-violet-500/50 bg-violet-500/15 text-violet-300 hover:bg-violet-500/25' },
  deliver: { icon: Flag, cls: 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30' },
}

/**
 * 检查点面板 —— 全产品唯一模态时刻,从下浮现带光晕(design.md §5)。
 * 按钮子集由 ALLOWED_ACTIONS[检查点类型] 决定(契约单一事实源);改向必带文本。
 */
export function CheckpointPanel({
  checkpoint,
  busy,
  onAction,
}: {
  checkpoint: Checkpoint
  busy?: boolean
  onAction: (action: DecisionAction, text?: string) => void
}) {
  const [inputFor, setInputFor] = useState<DecisionAction | null>(null)
  const [text, setText] = useState('')
  const [redirectError, setRedirectError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const meta = CP_META[checkpoint.type]
  const actions = ALLOWED_ACTIONS[checkpoint.type]

  const fire = (a: DecisionAction) => {
    if (a === 'redirect' || a === 'supplement') {
      setInputFor(inputFor === a ? null : a)
      setText('')
      setRedirectError(false)
    } else {
      onAction(a)
    }
  }
  // 改向必填:空文本不提交,给出可读错误并回到输入框——不再是灰按钮/Enter 双无反应的死胡同
  const confirmInput = () => {
    if (inputFor === 'redirect' && !text.trim()) {
      setRedirectError(true)
      inputRef.current?.focus()
      return
    }
    if (inputFor) onAction(inputFor, text.trim() || undefined)
    setInputFor(null)
    setText('')
    setRedirectError(false)
  }

  return (
    <div
      aria-busy={busy || undefined}
      className="animate-panel-rise rounded-2xl border border-sky-500/30 bg-zinc-900/85 p-6 shadow-[0_0_50px_-12px_rgba(14,165,233,0.45)] backdrop-blur"
    >
      <div className="mb-4 flex items-center gap-3">
        <span className="animate-pulse rounded-md border border-sky-500/50 bg-sky-500/10 px-2.5 py-1 font-mono text-xs font-bold text-sky-300">
          检查点 · {meta.label}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold">{checkpoint.title}</p>
          <p className="text-xs text-muted-foreground">{meta.hint}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {actions.map((a) => {
          const s = ACTION_STYLE[a]
          return (
          <button
            key={a}
            data-action={a}
            disabled={busy}
            onClick={() => fire(a)}
            className={cn(
              'flex items-center gap-2 rounded-xl border px-5 py-3 text-[15px] font-medium transition-all active:scale-95 disabled:opacity-50',
              s.cls,
              inputFor === a && 'ring-2 ring-white/30',
            )}
          >
              <s.icon className="size-4" />
              {ACTION_LABEL[a]}
            </button>
          )
        })}
      </div>

      {/* 决策在途可见:不再只有按钮变灰的沉默——弱网下点完决策这几秒,转圈+落库中告诉你点击已生效 */}
      {busy && (
        <p role="status" className="mt-3 flex items-center gap-2 text-xs text-sky-300">
          <Loader2 className="size-3.5 animate-spin" /> 决策落库中，请稍候…
        </p>
      )}

      {inputFor && (
        <div className="mt-4">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              autoFocus
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                if (redirectError && e.target.value.trim()) setRedirectError(false)
              }}
              onKeyDown={(e) => e.key === 'Enter' && !busy && confirmInput()}
              placeholder={inputFor === 'redirect' ? '新方向(必填),如:改用官方文档结构对比…' : '补充给 agent 的信息/材料…'}
              aria-label={inputFor === 'redirect' ? '新方向(必填)' : '补充给 agent 的信息或材料'}
              aria-invalid={redirectError || undefined}
              aria-describedby={redirectError ? 'cp-redirect-error' : undefined}
              className="h-11 flex-1 rounded-xl border border-white/15 bg-zinc-950 px-4 text-[15px] outline-none placeholder:text-zinc-600 focus:border-sky-500/60"
            />
            <button
              data-action="confirm"
              onClick={confirmInput}
              disabled={busy}
              className="flex h-11 items-center gap-1.5 rounded-xl bg-sky-500 px-5 text-[15px] font-medium text-white transition-all active:scale-95 hover:bg-sky-400 disabled:opacity-40"
            >
              注入 <ChevronRight className="size-4" />
            </button>
          </div>
          {redirectError && inputFor === 'redirect' && (
            <p id="cp-redirect-error" role="alert" className="mt-2 text-xs text-rose-300">
              改向必须给出新方向:填写后再提交。
            </p>
          )}
        </div>
      )}
    </div>
  )
}
