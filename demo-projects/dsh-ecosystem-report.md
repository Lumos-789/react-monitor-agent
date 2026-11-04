# DeepSeek Harness 插件生态一页报告

> 读者:没读过 DSH 的工程师。目标:一页读懂 DeepSeek Harness(下称 DSH,仓 `deepseek-ai/deepseek-harness`)的插件生态——插件怎么写、一个 bundle 由什么组成、怎么被装载、怎么跟运行中的 session 交互。
> 事实来源仅两份调研笔记:`H` = `.agents/research/harness-api.md`(DSH 源码静态调研),`R` = `.agents/research/superagent-build-recipe.md`(dsh-superagent 解构 + 本机构建实测)。本文不引入两份笔记之外的事实。

## §1 DSH 与它的插件世界观

DSH 仓库自述 **"Everything is a Plugin"**:宿主能力全部以插件形式挂在 **cordis** 插件框架上(cordis 被 vendored 在 `vendor/cordis/`)。(H §a)

核心心智模型:**context(ctx)是服务仓库**。每个插件拿到一个 `ctx`,服务就是 `ctx.<key>`——`ctx.tools`(工具注册)、`ctx.agents`(agent 注册表)、`ctx.sessions`、`ctx.llm`、`ctx.systemPrompt`、`ctx.sessionController`、`ctx.pluginManager` 等,共 100+ 个服务面。插件用 `inject` 声明依赖、`provide`/Service 构造提供实现;**加载顺序由服务可用性驱动**,而不是手工 boot 序列——依赖到齐自动加载,没有中央启动脚本。(H §a)

## §2 插件怎么写:入口、生命周期、事件面

**三种等价插件形状**(cordis `Plugin` 类型):函数 `(ctx, config) => any`、类(`Service` 子类,`super(ctx, 'name')` 后自动成为 `ctx.name`)、对象 `{ apply(ctx, config) }`。惯用写法是函数插件 + **命名导出** `name` / `inject` / `Config` / `apply`——命名导出能保留 loader 注入元数据(官方 `tool-todo` 即此形状)。(H §a)

**生命周期:没有显式 deactivate,teardown 全靠可逆 effect。** `ctx.plugin()` 一次加载 = 一个 fiber(插件实例);`ctx.on()` / `ctx.effect()` 的返回值是 disposer,fiber 卸载时**逆序执行**——这就是 cordis 的硬契约:**所有注册必须留 disposer**,bundle 卸载/热重载才干净。`ctx.inject(deps, cb)` 是带依赖的速写,依赖服务变化时 callback 卸载重跑。(H §a)

**事件面五种派发模式**:`emit`(同步观察)/ `waterfall`(around 中间件,不调 `next()` 即否决)/ `parallel` / `serial`(顺序 await,可 bail)/ `bail`;模式是事件契约的一部分。监控一个 session 最有用的面:`session/event`(session 每追加一条持久事件都发,append-only、重放即得全史)、**`tools/result`(冻结的最终结果快照——纯监控用这个)**、`agent/created` / `agent/status` / `agent/turn-stopping`(turn 边界)。所有 agent/session 事件带 scope 过滤:经 `agent.ctx` 注册的 listener 只收该 agent 的事件。(H §b)

## §3 一个 bundle 由什么组成(核心)

**bundle = 一个 npm 包**,同时携带三类入口,由 package.json 的 `dsh` 字段声明自己在 DSH 里的身份(R §0):

```
一个 DSH bundle(npm 包,样板 = dsh-superagent)
├── package.json
│    ├── exports: "."      → lib/index.js        宿主插件主入口(DSH host 按此加载)
│    │            "./client" → lib/client.js     client 面板(DSH Web 端加载,CJS + __ModuleLoader__ 包装)
│    │            "./github-watch" 等            附属宿主插件(同主入口,经 patch 插进 profile)
│    │            "./package.json"、"./locale/*.json"(loader 要读 manifest / i18n)
│    ├── dsh: { bundle: { patch: "./cordis.patch.yml" }   ← 必填:声明自己是 profile 的一个 patch 层
│    │         client: { platform: "web", inject: [ui 包] } ← 有前端面板才要
│    │         manifestVersion: 1 }
│    ├── peerDependencies: 全部 @deepseek-ai/*(host 与 client UI 各一组,由 DSH 运行时提供)
│    ├── engines.dsh: "^0.2.1-alpha.2"            ← 运行版本约束
│    └── files: lib / cordis.patch.yml / locale / prompts / skills(非代码资源随包发布)
├── cordis.patch.yml      ← 往 DSH 里插什么:`- insert:` 插插件行 + agent preset 行
├── src/index.ts          ← 宿主插件入口:name / inject(声明要哪些 host 服务)/ Config / apply
├── src/client/index.tsx  ← 面板入口:inject ['slots','locale','sessions','uiWorkspace'] + apply
├── src/sources/*.ts      ← 附属宿主插件(github-watch / feishu-watch 等,可选 disabled: true)
└── lib/                  ← tsdown 产物:宿主多 entry ESM + 面板单文件 CJS(id 必须等于包名)
```

**装载链**:patch 文件是顶层数组,`{insert: [entry...]}` 把插件行追加进 profile;非 insert 操作按 `id` 定位做**整字段覆盖**(config 整替不深合并)。四层组合:bundle 的 patch(按 `dsh.profile.bundles` 顺序)→ profile 自己的 `cordis.patch.yml`(用户层)→ 启动器层;后写的同 id 行覆盖先写的。entry 行 `Entry._init()` 按 `name` import 模块再 `ctx.registry.plugin()` 装载,行序无加载语义。安装:`dsh plugin --profile <name> add <package>`,装完 `reconcileProfilePlugins` 自动把声明了 `dsh.bundle.patch` 的依赖激活进 profile;**DSH 桌面端 Plugin Manager 的开关就是原地编辑 profile 的 cordis.patch.yml**(追加/回退 `{id, disabled}` 行)。(H §e)

## §4 与运行中 session 交互

**向运行中的 agent 注入输入**:每个 Agent 挂一个持久 inbox,两条队列——`next-turn`(每条独占一个完整 turn)和 `next-step`(挤进当前 turn 的下一个 step 边界,即 steering)。外部注入三档 API:`agent.followup(msg)`(排下一 turn 并唤醒)/ `agent.steer(msg)`(打进当前 turn 下一步;idle 则开 turn)/ `agent.inject(msg)`(只排模型可见上下文,不唤醒)。inbox 本身是 session projection,重启不丢。(H §c)

**注入要幂等、不冒充用户**:用 `freezeMessage` 组 UserMessage,`MessageId('<插件名>:<requestId>')` 当幂等键,`source.kind` 标自己(dsh-superagent 用 live 事件 + 持久化历史回放双查,跨重启不重发);拿 agent 句柄用 `ctx.sessionController.resolveAgent(id)`(进程外语义)或 `ctx.agents.get(id)`;投递确认前 `sessionPersistence.flush()`。(H §c、R §4.3)

**自定义工具**:`defineTool({ name, description, parameters, output:{schema, render}, execute })` + `ctx.tools.register()`,返回 disposer;`execute(args, exec)` 返回必须符合 `output.schema` 的 canonical JSON,`exec` 里有 agent/signal/deferContext/concludeTurn。参数 schema 是受限 JSON Schema 子集。监控别人的工具执行不经 register,走 §2 的 `tools/*` 事件。(H §d)

## §5 实证样板与上手建议

**dsh-superagent 是唯一完整第三方 bundle 样板,且配方已本机验证**:`pnpm install && pnpm build` 成功,`pnpm test` 59 文件 **1197 个测试全过**(13.6s)。构建链是 tsdown 双 config:宿主侧 ESM 多 entry + dts,**`neverBundle: @deepseek-ai/*`** 是命门(host 包必须保持外部依赖由 DSH 运行时提供);面板侧打成单文件 CJS,套 `window.__ModuleLoader__.load({id, factory})` banner——id 必须等于包名,`factory(require)` 里 `require('react')` 拿宿主 React。(R §0/§1/§5)

**上手建议**:以 dsh-superagent 为模板抄、不从零发明——R §6 给了 10 条按依赖顺序的可复用骨架清单(package.json 模板 / tsdown 双 config / stateDir 先锁再开库 / prefix HTTP + sameOrigin 头 / Session 创建五步 / inbox 投递三模式 / 内存假 host 的测试 harness 等),域逻辑(Trigger/Ticket/Engine)不抄。监控型插件的最小形状:一个插件 `inject: ['agents','tools']`,`ctx.on('session/event')` + `ctx.on('tools/result')` + `agent/*` 事件,所有注册留 disposer。(H「对新 bundle 项目的建议」、R §6)

**调研边界(引用数据时须知)**:H 是纯静态调研、未运行任何代码、行号未锁 commit SHA;`@deepseek-ai/*` peer 依赖在 npm 的可得性未验证(不可公开安装则 `link:` 本地装载);DSH host 真机装载第三方 bundle 的完整链路未实测。(H 头注、R §0)
