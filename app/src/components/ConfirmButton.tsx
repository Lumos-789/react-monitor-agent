import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * 破坏性动作二步确认:首击进入待确认(危险色 + 文案变更,4 秒或 Escape 自动撤销),再击才执行。
 * 用于「重新回放」——它会清空该工程已点的全部检查点决策,且不可撤销。
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel,
  className,
}: {
  onConfirm: () => void
  children: ReactNode
  confirmLabel: string
  className?: string
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const disarm = () => {
    window.clearTimeout(timer.current)
    setArmed(false)
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (armed) {
          disarm()
          onConfirm()
        } else {
          setArmed(true)
          timer.current = window.setTimeout(() => setArmed(false), 4000)
        }
      }}
      onKeyDown={(e) => {
        if (armed && e.key === 'Escape') disarm()
      }}
      className={cn(
        className,
        armed && 'border-rose-500/60 text-rose-300 hover:border-rose-400/70 hover:text-rose-200',
      )}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}
