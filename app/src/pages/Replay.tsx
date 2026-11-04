import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { rma, buildReplayNodes, type TimelineResponse } from '@/api'
import { CheckpointPanel } from '@/components/CheckpointPanel'
import { ConfirmButton } from '@/components/ConfirmButton'
import { FeedbackLog } from '@/components/FeedbackLog'
import { Timeline } from '@/components/Timeline'
import { ArtifactStage, CheckpointStage, ConsumeStage, EndStage, ForkStage, NoteStage, ProposeStage, ToolStage, WorkCreatedStage } from '@/components/stages'
import { isResolvingAction, STATUS_META, type Checkpoint, type Decision, type DecisionAction, type NodeStatus, type ReplayNode } from '@/types'
import { cn } from '@/lib/utils'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { ArrowLeft, CircleAlert, Flag, Pause, Play, RotateCcw } from 'lucide-react'

function dwellFor(n: ReplayNode): number {
  if (n.kind === 'checkpoint') return 2200
  if (n.kind === 'fork') return 2600
  switch (n.ev.type) {
    case 'work.created':
      return 2400
    case 'context.consumed':
      return 2800
    case 'context.proposed':
      return 4200
    case 'artifact':
      return 3400 + n.ev.evidence.length * 500
    case 'tool':
      return 2200
    case 'note':
      return Math.min(6500, 2200 + n.ev.text.length * 22)
  }
}

/** 播放速度档位:过程节点 dwell÷speed,长回放的过程叙事可快进;检查点等待节拍不受速度影响(§5:等待是唯一节拍) */
const SPEED_STEPS = [1, 1.5, 2]
function nextSpeed(cur: number, dir: 1 | -1): number {
  const i = SPEED_STEPS.indexOf(cur)
  return SPEED_STEPS[Math.min(SPEED_STEPS.length - 1, Math.max(0, (i === -1 ? 0 : i) + dir))]
}

export default function Replay() {
  const { workId = '' } = useParams()
  const [tl, setTl] = useState<TimelineResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [decideError, setDecideError] = useState<string | null>(null)
  const [ph, setPh] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const reloadLock = useRef(0)

  const reload = useCallback(async () => {
    const lock = ++reloadLock.current
    try {
      const data = await rma.getTimeline(workId)
      if (lock === reloadLock.current) {
        setTl(data)
        setError(null)
      }
    } catch (e) {
      if (lock === reloadLock.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [workId])

  // 断连横幅的手动重试在途可见并防连点(回放页无轮询,横幅重试是唯一自愈入口)
  const retry = useCallback(async () => {
    if (retrying) return
    setRetrying(true)
    try {
      await reload()
    } finally {
      setRetrying(false)
    }
  }, [reload, retrying])

  useEffect(() => {
    setTl(null)
    setPh(0)
    setPlaying(true)
    void reload()
  }, [reload])

  const folded = tl?.folded
  useDocumentTitle(folded ? `${folded.work.title} · 审查回放` : undefined)
  const nodes = useMemo(() => (tl ? buildReplayNodes(tl.events) : []), [tl])
  /** 检查点活状态来自 fold(事件内只是 raise 快照) */
  const cpById = useMemo(() => new Map((folded?.checkpoints ?? []).map((c) => [c.id, c])), [folded])
  const node = nodes[ph] as ReplayNode | undefined
  const atEnd = nodes.length > 0 && ph >= nodes.length

  // 过程节点自动推进;检查点暂停(§5:等待是唯一节拍)
  useEffect(() => {
    if (!playing || !node) return
    if (node.kind === 'checkpoint' && cpById.get(node.checkpoint.id)?.status === 'open') {
      setPlaying(false)
      return
    }
    const t = setTimeout(() => setPh((x) => x + 1), dwellFor(node) / speed)
    return () => clearTimeout(t)
  }, [playing, node, cpById, speed])

  // 播放到终点即停:playing 永不虚挂(终点按钮显示「播放」而非停滞的「暂停」)
  useEffect(() => {
    if (atEnd) setPlaying(false)
  }, [atEnd])

  // 键盘步进:空格播放/暂停(终点=从头再看)、←/→ 逐节点、]/[=跳下一/上一检查点(检查点是回放的关键帧,重看决策序列不必逐节点穿;无目标按键不动)、,/.=播放速度降/升档;定点查看即暂停,播放键续播。焦点在表单/按钮内不劫持(按钮空格=原生点击)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('button, input, textarea, select, [contenteditable]')) return
      const jumpCheckpoint = (dir: 1 | -1) => {
        for (let i = ph + dir; i >= 0 && i < nodes.length; i += dir) {
          if (nodes[i].kind === 'checkpoint') {
            setPh(i)
            setPlaying(false)
            return
          }
        }
      }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        if (atEnd) {
          setPh(0)
          setPlaying(true)
        } else setPlaying((p) => !p)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setPh((x) => Math.min(nodes.length, x + 1))
        setPlaying(false)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setPh((x) => Math.max(0, x - 1))
        setPlaying(false)
      } else if (e.key === ']' || e.key.toLowerCase() === 'n') {
        e.preventDefault()
        jumpCheckpoint(1)
      } else if (e.key === '[' || e.key.toLowerCase() === 'p') {
        e.preventDefault()
        jumpCheckpoint(-1)
      } else if (e.key === '.' || e.key === ',') {
        e.preventDefault()
        setSpeed((s) => nextSpeed(s, e.key === '.' ? 1 : -1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nodes, ph, atEnd])

  const statuses = useMemo(() => {
    const closed = new Set((folded?.branches ?? []).filter((b) => b.status === 'closed').map((b) => b.id))
    const m: Record<string, NodeStatus> = {}
    nodes.forEach((n, i) => {
      m[n.id] = closed.has(n.branch) ? 'rejected' : i < ph ? 'done' : i === ph ? 'active' : 'pending'
    })
    return m
  }, [nodes, folded, ph])

  const mergedNodes = useMemo(
    () => nodes.map((n) => (n.kind === 'checkpoint' ? { ...n, checkpoint: cpById.get(n.checkpoint.id) ?? n.checkpoint } : n)),
    [nodes, cpById],
  )

  const openCp: Checkpoint | undefined = node?.kind === 'checkpoint' ? cpById.get(node.checkpoint.id) : undefined
  const panelCp = openCp?.status === 'open' ? openCp : undefined

  // 检查点面板浮现即接管焦点:键盘/读屏审查者 Tab 一下就落在决策按钮(答得快);锚定容器(tabIndex=-1)而非按钮,空格仍是播放/暂停,不误触决策
  const panelAnchor = useRef<HTMLDivElement>(null)
  const hadPanel = useRef(false)
  useEffect(() => {
    if (panelCp && !hadPanel.current) panelAnchor.current?.focus()
    hadPanel.current = panelCp !== undefined
  }, [panelCp])

  // 换检查点/面板消失时清掉上一条决策错误
  useEffect(() => {
    setDecideError(null)
  }, [panelCp?.id])

  const decide = async (action: DecisionAction, text?: string) => {
    if (!panelCp) return
    setBusy(true)
    try {
      await rma.postDecision(workId, panelCp.id, { action, text })
      await reload()
      setDecideError(null)
      setPlaying(true) // 决策落库后推进过检查点;supplement 不解决则仍会在此暂停
    } catch (e) {
      // 决策失败是面板内事故:内联提示,面板与已输入文本保留可重试;不整屏替换(整屏 error 只属于加载失败)
      setDecideError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const restart = () => {
    rma.resetSession?.(workId)
    setPh(0)
    setPlaying(true)
    void reload()
  }

  // 断连不清舞台:首载失败才整屏;已有回放数据时保旧+细横幅可重试(回放页无轮询,不自愈)
  if (error && !tl) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <div className="rounded-2xl border border-rose-500/40 bg-rose-500/5 p-6">
          <p className="mb-2 font-mono text-xs tracking-widest text-rose-300 uppercase">回放加载失败</p>
          <p className="mb-4 text-sm break-all text-zinc-300">{error}</p>
          <Link to="/" className="text-sm text-sky-400 hover:text-sky-300">← 回操作板</Link>
        </div>
      </div>
    )
  }
  if (!folded || !tl) return <div className="p-10 font-mono text-sm text-zinc-500">正在加载回放…</div>

  const w = folded.work
  const decisionForCp = (cp: Checkpoint): Decision | undefined => {
    const resolving = folded.decisions.filter((d) => d.checkpointId === cp.id && isResolvingAction(d.action))
    return resolving[resolving.length - 1]
  }

  const stageNode = mergedNodes[ph]
  // 图标按钮可访问名与 title 同源:读屏稳定播报「播放/暂停/从头再看」而非兜底的「按钮」
  const playLabel = atEnd ? '从头再看（空格）' : playing ? '暂停（空格）' : '播放（空格）'
  const speedLabel = `播放速度 ${speed}x（, . 调速）`
  return (
    <div className="flex h-[calc(100vh-53px)] flex-col">
      {/* 顶栏 */}
      <header className="flex shrink-0 items-center gap-3 border-b border-white/5 px-5 py-2.5">
        <Link to="/" className="flex items-center gap-1.5 text-xs text-zinc-400 transition-colors hover:text-sky-300">
          <ArrowLeft className="size-3.5" /> 操作板
        </Link>
        <span className="text-sm font-semibold">{w.title}</span>
        <span
          className={cn(
            'rounded-md border px-2 py-0.5 font-mono text-[10px]',
            w.status === 'waiting' ? 'animate-pulse border-sky-400/60 text-sky-300' : w.status === 'done' ? 'border-emerald-500/40 text-emerald-400' : 'border-white/15 text-zinc-400',
          )}
        >
          {STATUS_META[w.status].label}
        </span>
      </header>

      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-sm text-amber-300"
        >
          <CircleAlert className="size-4 shrink-0" />
          连接已断开，正在显示已加载的回放。
          <button
            onClick={() => void retry()}
            disabled={retrying}
            className="ml-1 underline underline-offset-2 transition-colors hover:text-amber-100 disabled:pointer-events-none disabled:opacity-60"
          >
            {retrying ? '重试中…' : '重试'}
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 主区:舞台 + 检查点面板 + 底部时间线 */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div key={stageNode?.id ?? 'end'} className="animate-node-in mx-auto max-w-4xl">
              {!stageNode ? (
                <EndStage status={w.status} delivered={w.status === 'done'} />
              ) : stageNode.kind === 'checkpoint' ? (
                <CheckpointStage checkpoint={stageNode.checkpoint} decision={decisionForCp(stageNode.checkpoint)} />
              ) : stageNode.kind === 'fork' ? (
                <ForkStage node={stageNode} />
              ) : (
                <>
                  {stageNode.ev.type === 'work.created' && <WorkCreatedStage node={stageNode} />}
                  {stageNode.ev.type === 'context.consumed' && <ConsumeStage node={stageNode} />}
                  {stageNode.ev.type === 'note' && <NoteStage node={stageNode} />}
                  {stageNode.ev.type === 'artifact' && <ArtifactStage node={stageNode} />}
                  {stageNode.ev.type === 'tool' && <ToolStage node={stageNode} />}
                  {stageNode.ev.type === 'context.proposed' && <ProposeStage node={stageNode} />}
                </>
              )}
            </div>

            {/* 回放终点 CTA(不自动跳转,人说了算) */}
            {!stageNode && w.status === 'done' && (
              <div className="mt-5 flex justify-center gap-3">
                <Link
                  to={`/work/${workId}/done`}
                  className="flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-emerald-400"
                >
                  <Flag className="size-4" /> 查看完工态
                </Link>
                {/* 演示模式的重新回放会清空全部已点决策(不可撤销):二步确认;live 无 resetSession,restart 只是纯重看,直点 */}
                {rma.resetSession ? (
                  <ConfirmButton
                    onConfirm={restart}
                    confirmLabel="再点一次,重置全部决策"
                    className="flex items-center gap-2 rounded-xl border border-white/15 px-5 py-2.5 text-sm text-zinc-300 transition-all hover:border-white/30"
                  >
                    <RotateCcw className="size-4" /> 重新回放
                  </ConfirmButton>
                ) : (
                  <button onClick={restart} className="flex items-center gap-2 rounded-xl border border-white/15 px-5 py-2.5 text-sm text-zinc-300 transition-all hover:border-white/30">
                    <RotateCcw className="size-4" /> 重新回放
                  </button>
                )}
              </div>
            )}
            {!stageNode && w.status !== 'done' && (
              <div className="mt-5 flex justify-center">
                <Link to="/" className="flex items-center gap-2 rounded-xl border border-white/15 px-5 py-2.5 text-sm text-zinc-300 transition-all hover:border-sky-500/40 hover:text-sky-300">
                  回操作板 <ArrowLeft className="size-4 rotate-180" />
                </Link>
              </div>
            )}
          </div>

          {/* 检查点面板:全产品唯一模态时刻,从下浮现 */}
          {panelCp && (
            <div
              ref={panelAnchor}
              tabIndex={-1}
              role="group"
              aria-label={`检查点决策:${panelCp.title}`}
              className="shrink-0 px-6 pb-4 outline-none"
            >
              {decideError && (
                <div
                  role="alert"
                  className="mb-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300"
                >
                  <p className="mb-0.5 font-semibold">决策未落库，面板与已输入文本已保留，可直接重试。</p>
                  <p className="break-words font-mono text-xs text-rose-300/80">{decideError}</p>
                </div>
              )}
              <CheckpointPanel checkpoint={panelCp} busy={busy} onAction={decide} />
            </div>
          )}

          {/* 底部时间线 = 播放器进度条 */}
          <div className="shrink-0 border-t border-white/5 px-4">
            <div className="flex items-center gap-3 py-1">
              <button
                onClick={() => {
                  // 终点再按播放=从头再看(媒体播放器通例);纯回放 ph=0,不动会话决策(重置决策属于「重新回放」CTA)
                  if (atEnd) {
                    setPh(0)
                    setPlaying(true)
                  } else setPlaying((p) => !p)
                }}
                className="flex size-7 items-center justify-center rounded-lg border border-white/15 text-zinc-300 transition-all active:scale-95 hover:border-sky-500/50 hover:text-sky-300"
                title={playLabel}
                aria-label={playLabel}
              >
                {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              </button>
              <button
                onClick={() => setSpeed((s) => nextSpeed(s, 1))}
                title={speedLabel}
                aria-label={speedLabel}
                className="flex h-7 min-w-10 items-center justify-center rounded-lg border border-white/15 px-1.5 font-mono text-[10px] text-zinc-400 transition-all active:scale-95 hover:border-sky-500/50 hover:text-sky-300"
              >
                {speed}x
              </button>
              <span className="font-mono text-[10px] text-zinc-500" title="← / → 逐节点步进 · ] / [ 跳检查点 · , / . 播放速度">
                {Math.min(ph + 1, nodes.length)}/{nodes.length}
              </span>
            </div>
            <Timeline
              nodes={mergedNodes}
              statuses={statuses}
              activeIndex={ph}
              progress={nodes.length ? Math.min(1, (ph + 1) / nodes.length) : 0}
              onSeek={(i) => {
                setPh(i)
                setPlaying(false)
              }}
            />
          </div>
        </main>

        {/* 右侧窄反馈流 */}
        <aside className="hidden w-[280px] shrink-0 border-l border-white/5 p-4 md:block">
          <FeedbackLog decisions={folded.decisions} checkpoints={folded.checkpoints} />
        </aside>
      </div>
    </div>
  )
}
