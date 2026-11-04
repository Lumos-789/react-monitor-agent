# rma-core

react-monitor-agent 的插件内核:本机 localhost API + 事件库(JSONL)+ 检查点引擎 + 决策回注。
**零运行时依赖**(只用 node:http/fs/path/crypto),构建只需 tsc。契约唯一来源:`../.agents/tech-design.md`。

## 快速开始

```bash
cd core && npm ci
npm run build      # tsc → dist/
npm start          # http://127.0.0.1:8790 (RMA_PORT 覆盖,只绑回环)
npm run dev        # tsx watch
npm test           # node:test:状态机(fold)+ 14 端点集成 + fixture 重建
npm run seed -- <jsonl>   # 手动灌 fixture
```

环境变量:`RMA_HOME`(数据目录,缺省 `~/.rma`)、`RMA_PORT`(缺省 8790)、`RMA_NO_SEED=1`(禁用启动自动灌 fixture)、`RMA_SEED_FIXTURE`、`RMA_STATIC_DIR`(board 产物目录,缺省探测 `../app/dist`、`../board/dist`)。

**启动自动 seed**:数据目录为空(无 works.json、works/ 空、无 context 日志)时自动灌入 `fixtures/demo-fixture.jsonl`,便于演示;判空必须在构造 Store 之前(Store 构造会物化 works.json)。

## 端点(14 个,信封 `{ok,data}` / `{ok,error:{code,message}}`)

| Method | Path | 语义 |
|---|---|---|
| GET | `/api/health` | 连通性 `{version,uptimeMs,works}` |
| POST | `/api/works` | 创建 Work(同 id 同参 → 200 + `X-Idempotent-Replay: true`;异参 → 409 ID_EXISTS) |
| GET | `/api/works` | 列表 `?track=&status=`,updatedAt 降序 |
| GET | `/api/works/:workId` | 快照 + `openCheckpointId` |
| GET | `/api/works/:workId/timeline` | `?sinceSeq=N` 增量;原始事件 + fold 后 checkpoints/decisions/branches |
| POST | `/api/works/:workId/events` | 过程事件(note/artifact/tool/context.consumed/context.proposed/work.status=abandoned) |
| POST | `/api/works/:workId/checkpoints` | 上报检查点 → work=waiting;已有 open → 409 CHECKPOINT_OPEN |
| POST | `/api/checkpoints/:checkpointId/decisions` | 人提交决策(动作矩阵校验;redirect 必带 text) |
| GET | `/api/works/:workId/inbox` | 决策回注:`?wait=N`(≤60s 长轮询),未消费决策按 seq 升序 |
| POST | `/api/decisions/:decisionId/ack` | 消费确认(幂等) |
| GET | `/api/works/:workId/evidence/:fileId` | 取回 dataB64 落盘的证据文件 |
| POST | `/api/context` | 写 Context 条目(draft) |
| GET | `/api/context` | 列表 `?q=`(标题/标签)`?status=` |
| GET | `/api/context/:entryId` | 单条全文 |

CORS:`/api/*` 回显白名单 origin(`http://localhost:5173`、`http://127.0.0.1:5173`),OPTIONS 预检 204;白名单外不加头。

## worker(任何能 curl 的 agent)驱动序列

```
POST /api/works → 循环(GET inbox?wait=30 → 干活 → POST /events → 拿不准 POST /checkpoints → ack)→ 收到 deliver 即停
```

## 数据落盘(RMA_HOME)

```
works.json                      # WorkItem + context 条目物化缓存(原子写,可重建)
works/<workId>/timeline.jsonl   # 唯一事实源,append-only
works/<workId>/evidence/        # dataB64 证据落盘
context/entries.jsonl           # Context 条目日志(last-write-wins)
```

重建:works.json 缺失/损坏/与 fold 不一致 → 按 timeline.jsonl 全量 fold 重写;末行 torn write 截断并 fail-loud 打日志;「同时至多一个 open 检查点」invariant 违例 → 启动报错。

## 语义要点

- 状态机:`checkpoint.raised` → waiting;`approve/reject/redirect` → active;`deliver` → done;`supplement` 不解决检查点、不改状态。
- 分支:reject/redirect 关旧分支(closed 留痕,closedByDecisionId)+ 开新分支(main→b2→b3…);decision.made 事件带旧分支,其后事件带新分支。
- deliver 时:sourceWorkId 指向该 work 的 draft Context 条目翻 accepted(入库=人审过);deliver 之后才 proposed 的条目保持 draft(与 demo fixture 一致)。
- `fold.ts` 是纯函数导出(`rma-core/fold`),board 以 devDependency 复用同一状态机(tech-design D5)。
