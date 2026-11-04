import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  ACTION_LABEL,
  CP_META,
  type Checkpoint,
  type ContextEntry,
  type Decision,
  type Evidence,
  type ReplayNode,
  type WorkStatus,
} from '@/types'
import {
  CheckCircle2,
  CircleAlert,
  Database,
  ExternalLink,
  FileCode2,
  FileText,
  Flag,
  Hammer,
  Package,
  Sparkles,
  Wrench,
} from 'lucide-react'

/* ── 证据渲染(契约 Evidence 四 kind)────────────────────────── */

function DiffBlock({ text }: { text: string }) {
  const lines = text.replace(/\n$/, '').split('\n')
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-zinc-950">
      <p className="border-b border-white/5 px-4 py-2 font-mono text-[11px] text-zinc-500">diff</p>
      <div className="max-h-72 space-y-px overflow-y-auto p-3 font-mono text-xs">
        {lines.map((l, i) => {
          const cls = l.startsWith('+') ? 'bg-emerald-500/10 text-emerald-300' : l.startsWith('-') ? 'bg-rose-500/10 text-rose-300' : l.startsWith('@@') ? 'text-sky-400' : 'text-zinc-400'
          return (
            <div key={i} className={cn('rounded px-2 py-0.5 whitespace-pre-wrap', cls)}>
              {l || ' '}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function LinkRow({ url, caption }: { url: string; caption?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3 transition-colors hover:border-sky-500/40"
    >
      <ExternalLink className="size-4 shrink-0 text-sky-400" />
      <div className="min-w-0">
        {caption && <p className="truncate text-sm">{caption}</p>}
        <p className="truncate font-mono text-[11px] text-zinc-500">{url}</p>
      </div>
    </a>
  )
}

export function EvidenceList({ evidence, compact }: { evidence: Evidence[]; compact?: boolean }) {
  if (evidence.length === 0) return null
  return (
    <div className={cn('grid gap-3', compact ? '' : 'md:grid-cols-2')}>
      {evidence.map((e, i) => {
        if (e.kind === 'text')
          return (
            <div key={i} className="rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3">
              <p className="mb-1 flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-zinc-500 uppercase">
                <FileText className="size-3" /> text
              </p>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-zinc-300">{e.text}</p>
            </div>
          )
        if (e.kind === 'code_diff') return <div key={i}><DiffBlock text={e.text} /></div>
        if (e.kind === 'link') return <div key={i}><LinkRow url={e.url} caption={e.caption} /></div>
        return (
          <div key={i} className="overflow-hidden rounded-xl border border-white/10 bg-zinc-900/60">
            {e.kind === 'image' ? (
              <img src={e.url} alt={e.caption ?? e.path} className="max-h-64 w-full object-contain bg-zinc-950" />
            ) : (
              <div className="flex items-center gap-3 px-4 py-3">
                <FileCode2 className="size-4 text-zinc-400" />
                <div className="min-w-0">
                  <p className="truncate text-sm">{e.caption ?? '文件'}</p>
                  <p className="truncate font-mono text-[11px] text-zinc-500">{e.path}</p>
                </div>
              </div>
            )}
            {(e.caption || e.path) && e.kind === 'image' && (
              <p className="border-t border-white/5 px-4 py-2 font-mono text-[11px] text-zinc-500">{e.caption ?? e.path}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ── 过程节点:工程立项 ──────────────────────────────────────── */

export function WorkCreatedStage({ node }: { node: Extract<ReplayNode, { kind: 'process' }> }) {
  const ev = node.ev
  if (ev.type !== 'work.created') return null
  const w = ev.work
  const isContext = w.track === 'context'
  return (
    <Card className={cn('border-dashed', isContext ? 'border-violet-500/40 bg-violet-500/[0.04]' : 'border-sky-500/40 bg-sky-500/[0.03]')}>
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <div className={cn('flex size-12 items-center justify-center rounded-2xl', isContext ? 'bg-violet-500/10' : 'bg-sky-500/10')}>
          {isContext ? <Database className="size-6 text-violet-300" /> : <Hammer className="size-6 text-sky-400" />}
        </div>
        <p className="font-mono text-[10px] tracking-widest text-zinc-500 uppercase">工程立项</p>
        <p className="font-display text-xl font-bold">{w.title}</p>
      </CardContent>
    </Card>
  )
}

/* ── 过程节点:消费上下文(双轨连通)─────────────────────────── */

export function ConsumeStage({ node }: { node: Extract<ReplayNode, { kind: 'process' }> }) {
  const ev = node.ev
  if (ev.type !== 'context.consumed') return null
  return (
    <Card className="border-dashed border-violet-500/40 bg-violet-500/[0.04]">
      <CardContent className="p-8">
        <div className="mb-4 flex items-center gap-2 text-violet-300">
          <Database className="size-4" />
          <span className="font-mono text-xs tracking-widest uppercase">消费知识库</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {ev.entryIds.map((id) => (
            <span key={id} className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 font-mono text-xs text-violet-200">{id}</span>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/* ── 过程节点:叙事 / 产物 / 工具 ───────────────────────────── */

export function NoteStage({ node }: { node: Extract<ReplayNode, { kind: 'process' }> }) {
  const ev = node.ev
  if (ev.type !== 'note') return null
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-6">
          <p className="mb-2 flex items-center gap-2 font-mono text-[10px] tracking-widest text-zinc-500 uppercase">
            <Sparkles className="size-3 text-cyan-400" /> 过程叙事
          </p>
          <p className="text-base leading-relaxed whitespace-pre-wrap">{ev.text}</p>
        </CardContent>
      </Card>
      {ev.evidence && ev.evidence.length > 0 && <EvidenceList evidence={ev.evidence} />}
    </div>
  )
}

export function ArtifactStage({ node }: { node: Extract<ReplayNode, { kind: 'process' }> }) {
  const ev = node.ev
  if (ev.type !== 'artifact') return null
  return (
    <div className="space-y-4">
      <Card className="border-cyan-500/30 bg-cyan-500/[0.03]">
        <CardContent className="p-6">
          <p className="mb-1 font-mono text-[10px] tracking-widest text-cyan-300 uppercase">产物</p>
          <p className="font-display text-lg font-bold">{ev.title}</p>
        </CardContent>
      </Card>
      <EvidenceList evidence={ev.evidence} />
    </div>
  )
}

export function ToolStage({ node }: { node: Extract<ReplayNode, { kind: 'process' }> }) {
  const ev = node.ev
  if (ev.type !== 'tool') return null
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-6">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/5">
          <Wrench className="size-5 text-zinc-300" />
        </div>
        <div className="min-w-0">
          <p className="font-mono text-sm text-sky-300">{ev.tool}</p>
          <p className="truncate text-sm text-muted-foreground">{ev.summary}</p>
        </div>
      </CardContent>
    </Card>
  )
}

/* ── 过程节点:蒸馏回提(Context 闭环)──────────────────────── */

export function ProposeStage({ node }: { node: Extract<ReplayNode, { kind: 'process' }> }) {
  const ev = node.ev
  if (ev.type !== 'context.proposed') return null
  const e: ContextEntry = ev.entry
  return (
    <Card className="border-violet-500/30 bg-violet-500/[0.04]">
      <CardContent className="p-6">
        <div className="mb-3 flex items-center gap-2">
          <Database className="size-4 text-violet-300" />
          <span className="font-mono text-xs tracking-widest text-violet-300 uppercase">蒸馏回提</span>
          <Badge className="ml-auto border-violet-500/40 text-violet-300">{e.status === 'draft' ? '待入库' : '已入库'}</Badge>
        </div>
        <p className="font-display text-lg font-bold">{e.title}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {e.tags.map((t) => (
            <span key={t} className="rounded-md bg-white/5 px-2 py-0.5 font-mono text-[10px] text-zinc-400">#{t}</span>
          ))}
        </div>
        <p className="mt-3 rounded-xl border border-white/10 bg-zinc-950/60 px-4 py-3 text-sm leading-relaxed text-zinc-300">{e.content}</p>
      </CardContent>
    </Card>
  )
}

/* ── 检查点舞台:内容为王(方案/风险/交付的正文+证据)───────── */

const CP_STAGE_COLOR: Record<Checkpoint['type'], string> = {
  plan: 'border-sky-500/40 bg-sky-500/[0.05]',
  progress: 'border-cyan-500/40 bg-cyan-500/[0.04]',
  risk: 'border-amber-500/40 bg-amber-500/[0.04]',
  delivery: 'border-emerald-500/40 bg-emerald-500/[0.04]',
}

export function CheckpointStage({ checkpoint, decision }: { checkpoint: Checkpoint; decision?: Decision }) {
  const meta = CP_META[checkpoint.type]
  return (
    <div className="space-y-4">
      <Card className={CP_STAGE_COLOR[checkpoint.type]}>
        <CardContent className="p-6">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="rounded-md border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest text-zinc-300 uppercase">
              {meta.label}检查点
            </span>
            {decision && (
              <Badge className="ml-auto border-emerald-500/40 text-emerald-300">
                <CheckCircle2 className="size-3" /> 已决策 · {ACTION_LABEL[decision.action]}
              </Badge>
            )}
          </div>
          <p className="font-display text-xl leading-snug font-bold">{checkpoint.title}</p>
          {checkpoint.body && <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-zinc-300">{checkpoint.body}</p>}
        </CardContent>
      </Card>
      <EvidenceList evidence={checkpoint.evidence} />
    </div>
  )
}

/* ── 分叉痕:否定/改向的分支切换时刻 ────────────────────────── */

export function ForkStage({ node }: { node: Extract<ReplayNode, { kind: 'fork' }> }) {
  return (
    <Card className="border-sky-500/30 bg-zinc-900/70">
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <div className="flex size-12 rotate-45 items-center justify-center rounded-xl border border-sky-500/50 bg-sky-500/10">
          <Flag className="size-5 -rotate-45 text-sky-300" />
        </div>
        <p className="font-mono text-[10px] tracking-widest text-sky-300 uppercase">分支切换 · {ACTION_LABEL[node.action]}</p>
        <p className="font-display text-lg font-bold">
          {node.from} <span className="mx-1 text-sky-400">→</span> {node.to}
        </p>
        {node.text && <p className="max-w-lg rounded-lg bg-white/5 px-4 py-2 text-sm text-zinc-300">「{node.text}」</p>}
      </CardContent>
    </Card>
  )
}

/* ── 回放终点 ───────────────────────────────────────────────── */

export function EndStage({ status, delivered }: { status: WorkStatus; delivered: boolean }) {
  return (
    <Card className={delivered ? 'border-emerald-500/30 bg-emerald-500/[0.04]' : 'border-white/10'}>
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <div className={cn('flex size-12 items-center justify-center rounded-2xl', delivered ? 'bg-emerald-500/10' : 'bg-white/5')}>
          {delivered ? <CheckCircle2 className="size-6 text-emerald-400" /> : <CircleAlert className="size-6 text-zinc-300" />}
        </div>
        <p className="font-display text-lg font-bold">{delivered ? '时间线回放完毕 · Work 已完工' : '时间线到此为止'}</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {delivered ? '交付物已收货。' : status === 'waiting' ? '仍有检查点待人决策。' : '按你的决策推进中。'}
        </p>
      </CardContent>
    </Card>
  )
}

/* ── 完工态:交付清单行 ─────────────────────────────────────── */

export function DeliveryRow({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-background/60 px-4 py-3.5">
      <Package className="size-4 shrink-0 text-emerald-400" />
      <span className="text-sm font-medium">{title}</span>
      {desc && <span className="ml-auto text-right text-xs text-muted-foreground">{desc}</span>}
      <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
    </div>
  )
}
