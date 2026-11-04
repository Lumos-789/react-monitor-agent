# DSH 适配器 —— P2 后置(本次不实现)

本目录预留给 DSH bundle 适配器(薄适配层),当前**只有本 README,没有任何实现**。

规划见 `.agents/tech-design.md` §6,三个组件:

1. **collector**:`session/event` + `tools/result` → `POST /api/works/:id/events`(`tools/result` → `{type:'tool', tool, summary}`),按 sessionId↔workId 注册表路由,批量 200ms/20 条一刷。
2. **rma_checkpoint 工具**:`ctx.tools.register(defineTool(...))` → `POST /api/works/:id/checkpoints`,evidence 支持 dataB64。
3. **decision bridge**:`GET /api/works/:id/inbox?wait=30` 长轮询 → `freezeMessage` + `agent.followup()`/`agent.steer()` → `flush()` → `POST /api/decisions/:id/ack`;幂等靠 `MessageId('rma:<decisionId>')`。

依赖面(harness-api.md 自证为纯静态调研):`session/event` payload 形状、`freezeMessage`/`MessageId` 导出路径需真机首跑核对;`@deepseek-ai/*` peer 可得性未验证,不可装则改 `link:` 本地 profile。

在适配器落地前,任何能 curl 的 worker agent 都可以驱动完整闭环(契约同形):

```
POST /api/works → 循环(GET inbox?wait=30 → 干活 → POST /events → 拿不准 POST /checkpoints → ack)→ 收到 deliver 即停
```

bundle 骨架参考 `.agents/research/superagent-build-recipe.md`(package.json `dsh` 字段 + cordis.patch.yml + tsdown 双 config + `inject` 命名导出 + disposer)。
