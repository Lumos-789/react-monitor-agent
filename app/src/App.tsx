import { Routes, Route, Link } from 'react-router'
import Home from './pages/Home'
import Replay from './pages/Replay'
import Done from './pages/Done'
import { Activity } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { RMA_MODE } from './api'

export default function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 flex h-[53px] shrink-0 items-center gap-3 border-b border-white/5 bg-zinc-950/80 px-5 backdrop-blur">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg border border-sky-400/25 bg-sky-500/10">
            <Activity className="size-4 text-sky-300" />
          </span>
          <span className="font-display text-sm font-bold tracking-wide">React Monitor Agent</span>
        </Link>
        <span className="hidden h-4 w-px bg-white/10 sm:block" aria-hidden="true" />
        <span className="hidden text-[11px] text-zinc-500 sm:block">审查回放 · 检查点</span>
        {RMA_MODE === 'fixture' ? (
          <Badge
            className="border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-400"
            title="FIXTURE 离线演示模式：当前为内置示例工程，VITE_RMA_MODE=live 可连接 rma-core"
          >
            演示数据
          </Badge>
        ) : (
          <Badge
            className="border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-400"
            title="LIVE 模式：已连接 rma-core 实时数据"
          >
            实时数据
          </Badge>
        )}
      </header>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/work/:workId" element={<Replay />} />
        <Route path="/work/:workId/done" element={<Done />} />
      </Routes>
    </div>
  )
}
