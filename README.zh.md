# @deepseek-ai/dsh-team-orchestrator

[English](README.md) | 中文

## 摘要

`dsh-team-orchestrator` 把配置声明的模式表转换为可选择的团队配置,供子代理委派使用。每个模式声明自己的角色集合、选择角色的任务类型路由、并发上限与委派深度策略;每个角色固定一组精确的 provider、模型和思考强度。模式内的角色是宿主固定的数据:模型只选择模式与任务类型,从不指定路由。主路子代理失败时自动向角色的更强兜底路由升级一次。

本包为 pre-stable 软件:其公开契约可能随 DeepSeek Harness 的 pre-stable API 一起变化,恕不另行通知。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [开发本包](#develop-this-package)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在组合中(cordis.yml 或 overlay)声明模式。每个模式都是一套完整团队:

```yaml
- id: team-orchestrator
  name: '@deepseek-ai/dsh-team-orchestrator'
  config:
    provider: spawn
    defaultMode: fast
    modes:
      fast:
        brief: Deliver directly; check the result yourself before reporting.
        concurrency: 3
        maxDepth: provider-managed
        roles:
          planner:
            provider: deepseek-official
            model: deepseek-flash
            reasoningEffort: low
            brief: Design solutions and produce implementable briefs.
          coder:
            provider: deepseek-official
            model: deepseek-flash
            reasoningEffort: low
            brief: Execute the brief verbatim; make no design decisions.
            preset: minimal-tools
            maxTokens: 65536
        taskRouting:
          plan: planner
          implement: coder
      strict:
        brief: Every implementation is reviewed before you report completion.
        concurrency: 2
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
            maxTokens: 65536
            fallback:
              provider: deepseek-official
              model: deepseek-v4-pro
              reasoningEffort: high
          reviewer:
            provider: deepseek-official
            model: deepseek-v4-pro
            reasoningEffort: high
            brief: Review findings only; never implement.
        taskRouting:
          plan: planner
          implement: coder
          review: reviewer
```

挂载时拒绝空模式表、空角色表、空路由表、指向本模式未声明角色的路由项、没有任何 `taskRouting` 项指向的角色,以及与主路完全相同的角色兜底路由。`defaultMode` 只在恰好声明一个模式时可以省略——该模式即默认模式;声明多个模式而省略默认被拒绝而非猜测,`defaultMode` 指向未声明模式也被拒绝。每个模式的每条声明路由都会对照运行中的 LLM 运行时校验——provider 查找、精确模型元数据、思考强度可许性——在初始化时执行;provider 适配器尚未注册的路由推迟到下一次 `llm/adapters-updated` 事件,无效路由在该处失败。声明的角色 preset 在初始化时校验:agent-presets 服务未挂载或 preset id 无法解析即拒绝;agent-preset 能力要求 dsh 宿主 ≥0.2.1-rc.1(更旧的宿主只在角色确实声明 preset 时才拒绝挂载——随包默认配置不声明)。数值型 `maxDepth` 在 provider 注册时校验,provider 缺少 depthLimit 能力即拒绝;该校验与深度上限都按模式各自生效。

### 模式

模式拥有让一次部署比另一次更便宜或更严格的一切:有哪些角色、每个角色跑哪个模型与思考强度、该模式同时允许多少子代理、能递归多深。角色级 `preset`、`maxTokens`、`fallback` 也在模式内声明,因此便宜模式可以跑只读工具集的 coder,严格模式可以跑强模型 reviewer,而无需第二个插件实例。任务类型在所选模式内解析:只有一个模式声明过的类型在别的模式不可用,并被拒绝且列出该模式自己的类型表。

仅在声明了多个模式时,`team_dispatch` 才暴露可选的 `mode` 参数;单模式配置下每次派发都跑该模式,参数不存在。省略 `mode` 则跑 `defaultMode`。并发槽按模式各自计数,因此两个模式同时运行时各自保持自己的上限。模式的 `brief` 是给队长的提示词指引——它不是运行时闸门,任何模式都无法强制队长发出他没发出的后续派发。

### 兜底升级

每个角色可以声明一条更强的 `fallback` 路由(`provider`/`model`/`reasoningEffort`)。当该角色的主路子代理未完成结算——`error`、`max-tokens`、`refusal` 或任何非 `completed` 且非 `aborted` 的终止原因——插件自动在同一模式下用兜底路由重派同一任务一次,简报后附上失败尝试的终止原因。取消不触发升级,兜底尝试不再二次升级,两条路由都在派发时预检,无效兜底随派发当场失败而非中途暴露。`maxTokens` 限制每次子代理请求的输出预算,防 runaway 推理;`max-tokens` 结算是正常的兜底触发条件。`examples/weak-matrix.patch.yml` 是这套机制针对的场景:弱模型矩阵 + 强模型兜底。

### 从 0.1 升级

0.1 的配置声明一张扁平的 `roles`/`taskRouting`/`concurrency`/`maxDepth` 表。把那张表包进单个模式即可保持原有行为;出现第二个模式后再补 `defaultMode`:

```yaml
config:
  provider: spawn
  modes:
    fast:
      concurrency: 3
      roles: { ... }        # 原样不变
      taskRouting: { ... }  # 原样不变
```

残留的 0.1 顶层 `roles`、`taskRouting`、`concurrency` 或 `maxDepth` 会在挂载时被拒绝:这些字段不再被读取,留在 `modes` 旁边只会静默失效。

### 模型可见工具

`team_dispatch` 在所选模式内为一个任务类型启动一个子代理:模型传入 `mode`(仅在声明多个模式时)、`kind`、展示用的 `description`、完整简报,以及(provider 支持时)可选的 `output_schema` 约束子代理最终答复。工具把模式与类型解析到对应角色,经 LLM 运行时再次校验固定路由(及声明时的兜底路由),把角色的 `brief` 前置到子代理提示词,并用配置的 subagent 提供方以角色固定的 `AgentOptions`、preset 和该模式的深度上限启动子代理。返回值标明模式、角色、该角色失败时是否升级,并列出该类型近期的派发 label,重试时据以说明差异。`team_status` 按模式报告派发登记表:对照该模式 `concurrency` 的运行中数量、按角色的已派发/运行中/失败计数,以及已结算派发的 provider 上报 token 用量合计(取自本包自己的 `teamOrchestratorUsage` 会话投影;会话不再可读的子代理结算时不带用量快照)。队长提示词区在工具可见的 scope 渲染模式表、其类型→角色路由与简报纪律。

<a id="understand-the-implementation"></a>
## 理解实现

`resolveModes` 独立解析每个模式并选出默认模式;`resolveMode` 承担模式自身 schema 无法表达的跨字段引用检查,并为每个角色构建带品牌化思考强度 id 的子代理 `AgentOptions`。`resolveTaskKind` 在单个模式内把请求的类型映射到角色,未知类型会列出该模式已声明类型。`flattenRoles` 为在线路由校验给每个模式的角色加键,`validateRoleRoutes` 把路由可许性委托给 `LlmRuntime.resolveCallConfig`,provider 缺少适配器的路由报告为推迟而不是让挂载失败。两个工具与队长提示词区在配置的 subagent 提供方注册时挂载;缺失的 provider 在日志中可见,并通过 `subagent/provider-added` 稍后挂载。

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

派发登记表是进程内内存状态,不跨重启存活。从持久事件重建已推迟:`tool/result` 事件只携带渲染文本,不重建结构化结果字段或新增会话事件的话,派发工具的结构化输出(模式/类型与子代理的关联)无法从日志恢复。用量捕获覆盖会话仍可经 agents 服务读取的进程内子代理。并发按模式各自计数,因此同时运行子代理的总上限是各模式上限之和。模式的 `brief` 与队长提示词区都是提示词指引:插件无法强制队长发出他未发出的派发。`allowCaptainOverride` 已接受但保留:一旦启用,覆盖始终遵循子代理模型选择策略。
