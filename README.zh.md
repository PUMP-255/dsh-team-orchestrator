# @deepseek-ai/dsh-team-orchestrator

[English](README.md) | 中文

## 摘要

`dsh-team-orchestrator` 把配置声明的角色表转换为团队委派用的按角色子代理 LLM 路由。每个角色固定一组精确的 provider、模型和思考强度;任务类型路由表为被委派的任务选择角色。角色是宿主固定的数据:模型从不指定路由。主路子代理失败时自动向角色的更强兜底路由升级一次。

本包为 pre-stable 软件:其公开契约可能随 DeepSeek Harness 的 pre-stable API 一起变化,恕不另行通知。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [开发本包](#develop-this-package)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在组合中(cordis.yml 或 overlay)声明角色与任务类型路由:

```yaml
- id: team-orchestrator
  name: '@deepseek-ai/dsh-team-orchestrator'
  config:
    provider: spawn
    roles:
      planner:
        provider: deepseek-official
        model: deepseek-v4-pro
        reasoningEffort: high
        brief: Design solutions and produce implementable briefs.
      coder:
        provider: deepseek-official
        model: deepseek-flash
        reasoningEffort: low
        brief: Execute the brief verbatim; make no design decisions.
        preset: minimal-tools
    taskRouting:
      plan: planner
      implement: coder
      review: planner
    concurrency: 3
    maxDepth: provider-managed
```

挂载时拒绝空角色表、空路由表,以及指向未声明角色的路由项。每条声明的路由都会对照运行中的 LLM 运行时校验——provider 查找、精确模型元数据、思考强度可许性——在初始化时执行;provider 适配器尚未注册的路由推迟到下一次 `llm/adapters-updated` 事件,无效路由在该处失败。声明的角色 preset 在初始化时校验:agent-presets 服务未挂载或 preset id 无法解析即拒绝。数值型 `maxDepth` 在 provider 注册时校验,provider 缺少 depthLimit 能力即拒绝。

### 兜底升级

每个角色可以声明一条更强的 `fallback` 路由(`provider`/`model`/`reasoningEffort`)。当该角色的主路子代理未完成结算——`error`、`max-tokens`、`refusal` 或任何非 `completed` 且非 `aborted` 的终止原因——插件自动用兜底路由重派同一任务一次,简报后附上失败尝试的终止原因。取消不触发升级,兜底尝试不再二次升级,两条路由都在派发时预检,无效兜底随派发当场失败而非中途暴露。`maxTokens` 限制每次子代理请求的输出预算,防 runaway 推理;`max-tokens` 结算是正常的兜底触发条件。`examples/weak-matrix.patch.yml` 是这套机制针对的场景:弱模型矩阵 + 强模型兜底。

### 模型可见工具

`team_dispatch` 为一个任务类型启动一个子代理:模型传入 `kind`、展示用的 `description`、完整简报,以及(provider 支持时)可选的 `output_schema` 约束子代理最终答复。工具把类型解析到角色,经 LLM 运行时再次校验固定路由(及声明时的兜底路由),把角色的 `brief` 前置到子代理提示词,并用配置的 subagent 提供方以角色固定的 `AgentOptions`、preset 和深度上限启动子代理。返回值列出该类型近期的派发 label,重试时据以说明差异,并标明该角色失败时是否升级。`team_status` 报告派发登记表:对照 `concurrency` 的运行中数量、按角色的已派发/运行中/失败计数,以及已结算派发的 provider 上报 token 用量合计(取自本包自己的 `teamOrchestratorUsage` 会话投影;会话不再可读的子代理结算时不带用量快照)。队长提示词区在工具可见的 scope 渲染类型→角色表和简报纪律。

<a id="understand-the-implementation"></a>
## 理解实现

`resolveRoles` 承担 schema 无法表达的跨字段引用检查,并为每个角色构建带品牌化思考强度 id 的子代理 `AgentOptions`。`resolveTaskKind` 把请求的类型映射到角色,未知类型会列出已声明类型。`validateRoleRoutes` 把路由可许性委托给 `LlmRuntime.resolveCallConfig`,provider 缺少适配器的路由报告为推迟而不是让挂载失败。两个工具与队长提示词区在配置的 subagent 提供方注册时挂载;缺失的 provider 在日志中可见,并通过 `subagent/provider-added` 稍后挂载。

<a id="develop-this-package"></a>
## 开发本包

```sh
npm install    # 安装依赖
npm run build  # 从 src/ 产出 lib/(JavaScript、声明与 sourcemap)
npm run test   # vitest 单元测试
```

`lib/` 随仓库提交:使用者安装本包无需构建。`src/` 变更后重新构建并提交 `lib/`;`npm publish` 通过 `prepublishOnly` 再跑一次构建与测试。插件与其他 DSH 插件一样挂载:在 cordis.yml(或 overlay)中按上文配置列出即可,DSH 运行时会从自身安装解析 `@deepseek-ai` 的 peer 依赖。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

派发登记表是进程内内存状态,不跨重启存活。从持久事件重建已推迟:`tool/result` 事件只携带渲染文本,不重建结构化结果字段或新增会话事件的话,派发工具的结构化输出(类型与子代理的关联)无法从日志恢复。用量捕获覆盖会话仍可经 agents 服务读取的进程内子代理;兜底升级要求结算时恰有并发空位,无空位时放弃升级并告警。`allowCaptainOverride` 已接受但保留:一旦启用,覆盖始终遵循子代理模型选择策略。
