import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { rma, type TimelineResponse } from '@/api'
import { STATUS_META } from '@/types'
import { FeedbackLog } from '@/components/FeedbackLog'
import { ConfirmButton } from '@/components/ConfirmButton'
import { DeliveryRow } from '@/components/stages'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { Card, CardContent } from '@/components/ui/card'
import { ArrowLeft, RotateCcw, Timer, GitBranch, ListChecks, MessagesSquare, Milestone, Workflow, Database } from 'lucide-react'

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`
}

export default function Done() {
  const { workId = '' } = useParams()
  const navigate = useNavigate()
  const [tl, setTl] = useState<TimelineResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    rma
      .getTimeline(workId)
      .then(setTl)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [workId])

  const info = useMemo(() => {
    if (!tl) return null
    const f = tl.folded
    const deliveryCp = [...f.checkpoints].reverse().find((c) => c.type === 'delivery' && c.status === 'resolved')
    const deliverDecision = f.decisions.find((d) => d.id === deliveryCp?.resolvedByDecisionId)
    const artifacts = tl.events.filter((e) => e.type === 'artifact').map((e) => ({ seq: e.seq, title: (e as { title: string }).title }))
    const checklist = (deliveryCp?.body ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-') || l.startsWith('•'))
      .map((l) => l.replace(/^[-•]\s*/, ''))
    const processCount = tl.events.filter((e) => ['note', 'artifact', 'tool', 'context.consumed', 'context.proposed', 'work.created'].includes(e.type)).length
    const duration = deliverDecision ? new Date(deliverDecision.createdAt).getTime() - new Date(f.work.createdAt).getTime() : 0
    return { f, deliveryCp, deliverDecision, artifacts, checklist, processCount, duration }
  }, [tl])

  useDocumentTitle(info ? `${info.f.work.title} · 完工态` : undefined)

  if (error) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <div className="rounded-2xl border border-rose-500/40 bg-rose-500/5 p-6">
          <p className="mb-2 font-mono text-xs tracking-widest text-rose-300 uppercase">完工态加载失败</p>
          <p className="mb-4 text-sm break-all text-zinc-300">{error}</p>
          <Link to="/" className="text-sm text-sky-400 hover:text-sky-300">← 回操作板</Link>
        </div>
      </div>
    )
  }
  if (!tl || !info) return <div className="p-10 font-mono text-sm text-zinc-500">正在加载完工态…</div>

  const { f, deliveryCp, deliverDecision, artifacts, checklist, processCount, duration } = info
  const w = f.work

  if (w.status !== 'done') {
    return (
      <div className="mx-auto max-w-xl p-10">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="mb-2 font-display text-lg font-bold">该工程尚未完工</p>
            <p className="mb-5 text-sm text-muted-foreground">当前状态:{STATUS_META[w.status].label}。完工态只在交付收货(deliver)后出现。</p>
            <Link to={`/work/${workId}`} className="text-sm text-sky-400 hover:text-sky-300">→ 去审查回放</Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  const stats = [
    { icon: Timer, label: '总时长', value: fmtDuration(duration) },
    { icon: Milestone, label: '检查点', value: `${f.checkpoints.length} 个` },
    { icon: MessagesSquare, label: '人的决策', value: `${f.decisions.length} 次` },
    { icon: GitBranch, label: '分支', value: `${f.branches.length} 条` },
    { icon: Workflow, label: '过程节点', value: `${processCount} 个` },
    { icon: Database, label: '上下文回提', value: `${f.contextProposed.length} 条` },
  ]

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 pb-12">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/" className="flex items-center gap-1.5 text-xs text-zinc-400 transition-colors hover:text-sky-300">
          <ArrowLeft className="size-3.5" /> 操作板
        </Link>
        <h1 className="font-display text-xl font-bold">完工态 · {w.title}</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-6">
          {/* 交付清单 */}
          <Card className="border-emerald-500/30 bg-emerald-500/[0.04]">
            <CardContent className="p-6">
              <p className="mb-1 flex items-center gap-2 text-xs tracking-widest text-emerald-400 uppercase">
                <ListChecks className="size-4" /> 交付清单
              </p>
              <p className="mb-4 font-display text-lg font-bold">{deliveryCp?.title ?? '交付物'}</p>
              <div className="space-y-3">
                {checklist.map((item) => (
                  <DeliveryRow key={item} title={item} />
                ))}
                {artifacts.map((a) => (
                  <DeliveryRow key={a.seq} title={a.title} />
                ))}
                {checklist.length === 0 && artifacts.length === 0 && <p className="text-sm text-muted-foreground">交付检查点未携带清单正文。</p>}
              </div>
              {deliverDecision?.text && (
                <p className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-zinc-300">收货评语:「{deliverDecision.text}」</p>
              )}
            </CardContent>
          </Card>

          {/* 统计 */}
          <Card>
            <CardContent className="p-6">
              <p className="mb-4 text-xs tracking-widest text-muted-foreground uppercase">工程统计</p>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                {stats.map((s) => (
                  <div key={s.label} className="rounded-xl border border-white/10 bg-zinc-900/40 px-4 py-3">
                    <p className="mb-1 flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                      <s.icon className="size-3.5 text-sky-400" /> {s.label}
                    </p>
                    <p className="font-display text-lg font-bold">{s.value}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 决策审计 */}
        <Card className="max-h-[70vh] overflow-hidden">
          <CardContent className="h-full p-5">
            <FeedbackLog decisions={f.decisions} checkpoints={f.checkpoints} />
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-center gap-3">
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 rounded-xl border border-white/15 px-5 py-2.5 text-sm text-zinc-300 transition-all hover:border-sky-500/40 hover:text-sky-300"
        >
          <ArrowLeft className="size-4" /> 回操作板
        </button>
        {rma.resetSession && (
          <ConfirmButton
            onConfirm={() => {
              rma.resetSession?.(workId)
              navigate(`/work/${workId}`)
            }}
            confirmLabel="再点一次,重置全部决策"
            className="flex items-center gap-2 rounded-xl border border-white/15 px-5 py-2.5 text-sm text-zinc-300 transition-all hover:border-white/30"
          >
            <RotateCcw className="size-4" /> 重新回放
          </ConfirmButton>
        )}
      </div>
    </div>
  )
}
