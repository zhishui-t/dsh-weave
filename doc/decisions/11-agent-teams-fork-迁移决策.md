# 11. Agent Teams Fork 迁移 + DSH v0.1.2-alpha.1 升级影响评估（定稿记录）

> 本文件只记录已定案决策。未定事项在文末单独列出。
> 状态：规划定稿（尚未开始业务代码改造）

## 1. 目标与边界

- **队伍、成员、任务、调度、会话协作：全用 fork 的 dsh-agent-teams，不自研。**
- **weave 只保留：团队配置（yaml）、知识库、会话反思、ACP/fork 执行器接入，以及图谱/Obsidian/AnyDoc 等与团队无关的独立能力。**
- fork 源：`K:\work\GitHub\dsh-agent-teams`（上游 `NanmiCoder/dsh-agent-teams`，当前 v0.1.14 / `5fe388f`）。
- DSH 主线版本：当前已安装的 `0.1.1-rc.2`（不升级）。
- DSH 预研版本：`v0.1.2-alpha.1`（未发布 npm，源码构建使用）。
- DSH 源码：`K:\work\GitHub\deepseek-harness`，tag `dsh-v0.1.2-alpha.1`，commit `cd5ef81`。
- weave 基线：`6513558`，工作在 `master` 上做，不另开 feature 分支。

### 1.1 替换动机与自研纪律（用户定案）

- 动机：weave 自研任务/团队核心复杂度失控（14 态状态机、多个调度/委派/通知旁路、持续热修），质量与维护成本不划算；fork 的 dsh-agent-teams 团队/任务生命周期已成熟，故核心整体切换。
- 纪律：**只做适配，不复制旧语义**。
  1. 不把 weave 的 14 态状态机、BANNED/COOLDOWN/AWAITING_FEEDBACK 等旧语义搬进 fork；
  2. 接受 fork 的 6 态 + round/verdict/quality-gates 语义；
  3. fork 补丁只加执行器/配置字段和事件钩子，不重写其调度核心；
  4. weave 保留的模块必须是被实战验证过的独立能力，不再新增自研任务引擎代码。

### 1.2 内部细节清理边界（用户定案）

- 问题：weave 内部细节过多（通知旁路、回合守卫、状态派生、会话键、修订追踪等），是主要 bug 来源。
- 原则：**能用 fork 原生能力的，一律用原生的；旧内部细节默认不迁移。**
- 明确迁移（仅这些）：
  1. yaml 团队配置 → fork profile 的纯数据映射；
  2. 会话启用团队 → 触发 fork 建队；
  3. 知识库 → 建队注入 + 成员工具白名单；
  4. 任务终态事件 → 反思沉淀；
  5. ACP 执行器 → `AcpMemberTransport`；
  6. ACP 会话索引 v2 → `ExecutorSessionStore`。
- 明确不迁移 / 退役：
  - 14 态状态机与失败传播
  - `TaskStatusNotifier` 旁路通知
  - `CaptainTurnGuard` 回合硬约束
  - 自研 scheduler / planner / delegation 细节
  - 自研任务工具命名与 CLI 任务治理细节（改用他的 `agent_teams_*`）
- 新增代码硬约束：
  - 不新增任务状态；
  - 不新增调度循环；
  - 不新增团队状态文件；
  - 每个新增模块只允许一个明确职责。

## 2. 已定案决策

### D0 暂不升级 DSH alpha（重要）

- 主线继续使用当前已安装的 `0.1.1-rc.2`，现有 `web` profile 与所有已装插件保持原状。
- fork 迁移先在 rc.2 上完成并验证；alpha 源码（`K:\work\GitHub\deepseek-harness`）仅用于差异对照与预研。
- 升级 alpha 推迟到满足以下任一条件后，再走独立 `web-alpha` profile：
  1. 受影响的第三方插件完成 alpha 适配；
  2. alpha 发布 npm 正式包；
  3. 我们确实需要 alpha 独有的能力（childId 预分配、subagent/end、标准 ACP resume/model/MCP）。
- 不升级时，现有插件影响为 0；升级时第 6 节列出的 🔴 插件会短时间不可用。

### D1 团队/任务引擎全部用他的

- 建队、成员、任务、调度、状态、ActivityPanel、质量门禁：用 fork。
- weave 现有任务/团队引擎模块最终退役：
  - `planner.ts`
  - `scheduler.ts`
  - `delegation-service.ts`（其知识注入与 ACP sessionKey 能力下沉到 transport）
  - `state/task-state-machine.ts`、`state/types.ts`
  - `session-tracker.ts`（观察后退役）
  - `captain-turn-guard.ts`
- `team-manager.ts` 保留为 **yaml 团队配置加载/校验/会话绑定**，删除自研建队与派发逻辑。

### D2 保留 yaml 团队配置，会话启用时按配置创建小队

- 团队配置唯一来源：`~/.dsh/teams/*.yaml`。
- 会话启用团队流程：
  1. `findTeamByCaptain(sessionId)` 命中 → 复用既有 team，不重复建队。
  2. 未命中 → yaml `TeamConfig` 转换为 fork 的 `TeamProfileConfig`。
  3. 生成会话级唯一 teamId：
     ```
     teamId = sanitizeKey(`${yamlTeamId}-${shortSessionId}`)
     ```
  4. 调用 fork 的建队入口创建小队。
  5. 持久化绑定：`sessionId ↔ yaml team_id ↔ teamId`。
- 他的约束必须遵守：
  - teamId 在同一 workspace 的 `.agent-teams` 下唯一；
  - 一个 captain 会话同时只能属于一个 team；
  - `TeamState.captainSessionId` 是会话绑定真相。
- fork 需要新增一个程序化建队入口（不走模型自行决定），供会话启用时调用。

### D3 子代理管理抽象：MemberTransport

- 把 fork 中焊死在 `ctx.subagents` 上的成员管理抽象掉：

```ts
interface MemberTransport {
  kind: string
  provision(member, ctx): Promise<{ memberId: string }>
  isAvailable(member): boolean
  deliver(member, ticket, hooks): Promise<{ accepted: boolean }>
  interrupt(member): void
  dispose(member): Promise<void>
}

interface MemberDeliverHooks {
  onSettled(outcome: {
    member: TeamMember
    ticket: DispatchTicket
    output: string
    failed: boolean
    stopReason?: string
  }): Promise<void>
  onStatusChange(member: TeamMember, status: 'idle' | 'working'): void
}
```

- 内置 `DshMemberTransport`：包装原 `startContinuable / followup / interrupt`，spawn/fork 用。
- `AcpMemberTransport`：由 weave 实现并注册进 fork，把 ACP `start()` 包装成他期望的成员语义。
- 调度器只认 `MemberTransport`，不关心底层是 spawn/fork 还是 ACP。

### D4 执行器能力

- **DSH spawn / fork**：直接走内置 `DshMemberTransport`。
  - `dsh-subagent-fork-in-process@0.1.2-alpha.1` 已确认 `agentOptions:true`、`toolFilter:true`、`persona:true`、`prepareContinuable` 存在。
  - yaml 角色配置 `executor: fork` 即可，无需自研。
- **ACP**：分两层看：
  - ACP 协议层（`packages/acp/acp`）：alpha.1 已补全标准 `session/new` / `resume` / `list` / `close`、模型设置（model-control）、MCP 挂载。
  - DSH 子代理门面（`dsh-subagent-acp`）：能力仍为 `agentOptions:false / outputSchema:false / depthLimit:false / toolFilter:false / persona:false`，无 `prepareContinuable`，每次官方 `start()` 都走 `session.new`。
- 因此 ACP 成员仍由 weave 的 `AcpMemberTransport` 包装，但 transport 可以使用 alpha 的标准 ACP resume / model / MCP 能力：
  - ACP 成员不要求自己调 `agent_teams_*` 工具，任务状态由 **主机侧 `onSettled` 代写**；
  - spawn/fork 成员保持“子代理自己调 `agent_teams_*`”的原有语义。

### D5 ACP 会话索引（v2）

- 索引路径暂保持用户目录：
  ```
  ~/.dsh/weave/acp-session-index.json
  ```
- 暂不迁入项目目录的 `.agent-teams/`。
- Schema v2：

```json
{
  "version": 2,
  "keys": {
    "<workspaceFingerprint>:<teamId>:<roleId>": {
      "type": "zcode",
      "acpSid": "acp-xxxxxxxx-xxxx-xxxx",
      "updatedAt": 1787934986868
    }
  }
}
```

- `type` 字段含义：**后端 agent 标识**（当前 `zcode`，未来可为其它 agent），不是协议类型。
- 不存 `cwd`，不依赖 `zcodeSid`。
- 旧记录没有 `type` 或带 `cwd` 时只读兼容；新写入一律 v2 形态。

### D6 ACP sessionKey 与会话隔离

- ACP 会话必须按“会话实例 × 角色”隔离：

```
sessionKey = `${workspaceFingerprint}:${teamId}:${roleId}`
workspaceFingerprint = sha1(realpath(workspace))
teamId = 会话级唯一 teamId（见 D2）
```

- 同项目同会话同角色 → 复用 ACP 会话。
- 不同项目/不同会话同名团队 → 各自独立 ACP 会话。
- zcode 真正的后端会话仍由 ZCode 管理；weave 索引只保存引用。
- AgentTeams 自己的状态在 `<workspace>/.agent-teams/<teamId>/`，与 ACP 索引分离，互不删除。

### D7 知识库接入

- 建队时：`KnowledgeEngine.searchForInjection` 按项目/角色检索，结果写入 fork 的 `protocol`（队长）与成员 `executionPrompt`（成员）。
- 运行中：成员工具白名单放行 `weave_knowledge_search`。
- 知识库存储、审核、图谱 UI 全部保留 weave 现有实现。

### D8 会话反思接入

- 触发源优先级：
  1. alpha.1 新事件 `subagent/end`（`SubagentRunEndInfo`：runId/provider/stopReason/lastAssistantMessage）
  2. fork 的 `agent-teams/task-updated`（终态 completed / failed）
- 桥接映射：

```
TeamTask.id          → ReflectionDepositInput.taskId
member.executor      → executor
member.role / name   → roleId
yamlTeamId           → projectId
teamId(会话实例)      → version
task.output          → outputText
task.subject         → taskSubject
```

- 随后调用现有 `ReflectionService.depositFromOutput`，写入知识库 + 审计。
- `reflection-service.ts` 保留，不重写。

### D9 会话启动注入

- 保留 weave 现有“启用团队”自然语言入口与 team_bindings。
- 内部动作从“自研建队”替换为：
  1. 读绑定团队 yaml 配置；
  2. 转换 profile；
  3. 检查/复用或新建会话级 teamId；
  4. 调 fork 建队；
  5. 注入团队简介与知识。
- 会话 notice、危险窗口处理等现有会话通道能力保留。

## 3. DSH v0.1.2-alpha.1 兼容性结论

### 3.1 必须适配的破坏性变更

| # | 变更 | 对 fork / weave 的影响 |
|---|---|---|
| B1 | `SubagentCapabilities` 新增 `agentOptions` | 自定义 provider 必须补齐该字段；fork transport 按 alpha 类型编译 |
| B2 | `SubagentStartRequest` 为严格字段集，不再容纳 `sessionKey` / `weave` 透传 | weave 现有 `ctx.subagents.start(..., { sessionKey, weave })` 必须退役；ACP 改走自有 `ExecutorProvider.start` |
| B3 | `startContinuable` 强制要求 session persistence + session query | 宿主 composition 必须加载对应服务，否则 `CONTINUATION_UNAVAILABLE` |
| B4 | 官方 `dsh-subagent-acp` 门面仍是一次性 `session.new`，不暴露 `SubagentCapabilities` / `prepareContinuable`；但 ACP 协议层本身已补全 | member 级会话复用仍需走 weave 自有 ACP provider；但 transport 可以使用标准 ACP 的 resume / list / close 能力 |
| B5 | 移除 `@deepseek-ai/dsh-client-runtime` 包 | dsh-agent-teams fork 的 `dsh.client.inject` 必须移除该依赖并适配新的 client 注入面 |
| B6 | `MarkdownText` 的 `labels` 契约变为必填嵌套结构 | fork / weave 客户端渲染代码需同步适配，否则预览崩溃 |
| B7 | 引入 Remote Gateway + 一次性 Token 浏览器鉴权 | 本地开发/联调 profile、web 测试启动方式需按新架构调整；启动 URL 不再可直接访问 |
| B8 | 后端 API 端点从点分隔改为斜杠分隔，且请求参数必须按特定结构包装 | fork 现有 HTTP 路由与 weave 的 rpc / web 调用必须按新端点契约迁移 |
| B9 | Code Mode 正式更名 | yaml `mode`、ACP mode 映射、UI 文案中的旧模式名需改为新名称 |

### 3.2 可直接利用的新能力

| # | 能力 | 用途 |
|---|---|---|
| N1 | 子代理独立选模型：`agentOptions.provider / model / reasoningEffort / maxTokens` | yaml 角色的 `provider / model / thought_level` 直接映射到成员 `agentOptions` |
| N2 | Claude Code / Codex 子代理也支持模型配置 | 后续扩展 codex/claude 执行器时复用 |
| N3 | `ContinuableStartSpec.childId` 预分配 | spawn/fork 成员可先落稳定 childId 再物化，重启恢复更稳 |
| N4 | `subagent/start` / `subagent/end` 统一生命周期事件 | fork 任务完成观测、反思桥接、ACP transport `onSettled` |
| N5 | ACP 协议层补全：`session/new` / `resume` / `list` / `close` + 模型设置 + MCP | `AcpMemberTransport` 直接使用标准 resume / model-control / MCP 能力；不再依赖非标透传 |
| N6 | 插件信息上报：请求附带已启用插件的包名与版本 | weave / fork 的插件标识、排障信息可直接复用 |
| N7 | 可选 Session 日志增量上传（默认关闭） | 团队会话排障能力；是否开启作为配置项评估 |
| N8 | 支持注册第三方语言并补全多语言文本 | fork / weave UI 文案可接入宿主多语言体系 |
| N9 | 登录页扩展：插件可在模型设置页添加提供方登录配置 | weave ACP / 模型登录入口可走官方扩展点 |

### 3.3 版本约束

- alpha.1 未发布 npm，使用源码构建。
- root engines：`^22.19.0 || >=24.0.0`；本地 Node `v24.15.0` 满足。
- fork 的 peer deps 当前是 `^0.1.0-rc.6` 一档，需要更新到 `0.1.2-alpha.1` 后重新过 fork `verify`。
- weave 当前 `package.json` engines 为 `>=20`，若与 alpha 宿主共同构建，需评估提高到 `^22.19.0 || >=24.0.0`。

### 3.4 ACP 输出链路

- 协议层 `session/update` 实时流：
  - `agent_thought_chunk`（思考）
  - `agent_message_chunk`（正文）
  - `tool_call` / `tool_call_update`（工具生命周期）
  - context usage / 上下文压力
- `dsh-subagent-acp` 最终结果：
  - `SubagentRun.result.output`：最后一条非空 assistant message；否则累计文本流；否则 `[]`
  - abort / 进程退出时保留 partial output
  - `diagnostic` 与 output 分离，上限 4096 字节
  - 思考块不混入最终 output
  - `outputSchema: false` → ACP 子代理无结构化输出
- `AcpMemberTransport` 接线：
  - 实时流 → 会话面板 / 任务进度通知
  - `result.output` → `TeamTask.output` + 反思输入
  - partial output → 失败任务现场
  - `result.diagnostic` → 任务错误信息
  - 反思仅解析文本输出，不受无结构化输出影响

## 4. 待定事项

1. fork 放哪个 GitHub 组织/仓库名。
2. UI 是否直接全用他的 ActivityPanel（倾向：是）。
3. 任务工具命名是否全部退到他的 `agent_teams_*`（倾向：是）。
4. 任务状态持久化是否接受他的 `.agent-teams/` JSON；weave SQLite 只留知识/审计（倾向：是）。
5. yaml 字段 `mode` 暂以团队 protocol 描述承载，还是 fork 增加原生字段；并确认 Code Mode 新名称映射。
6. Remote Gateway 鉴权下，本地 e2e / Playwright 的启动 profile 采用什么形态。
7. Session 日志增量上传是否开启（默认关闭）。

## 5. 实施阶段（小步快跑）

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 | 接口/类型定稿：MemberTransport、建队入口、task-settled、profile 映射、ACP 索引 v2 | `pnpm typecheck` |
| P1 | 建立 fork；在 **当前 rc.2** 上验证 fork 原测试与插件加载（暂不提 alpha peer deps） | fork `pnpm verify` + 当前 web profile 冒烟 |
| P2 | fork 增加 `executor` 字段；抽取 MemberTransport，spawn/fork 走 alpha `startContinuable`（含 childId 预分配） | fork 原测试全绿 |
| P3 | fork 增加程序化建队、事件钩子、prompt enrich 钩子 | fork 单测 |
| P4 | weave：yaml→profile 映射 + 会话启用建队 | 纯函数单测 + 冒烟 |
| P5 | weave：知识注入 + 反思桥接（优先 `subagent/end`） | 单元测试 |
| P6 | weave：AcpMemberTransport + ACP 索引 v2 + sessionKey；退役 `ctx.subagents.start` 透传路径 | mock 测试 → 真 zcode 冒烟 |
| P7 | 双插件集成：spawn / fork / acp 三种团队各跑通一个完整任务 | e2e（适配 Remote Gateway 鉴权 + 斜杠端点契约） |
| P8 | 退役旧任务/团队模块，清测试，更新 README/doc | 全量回归 |
| P9 | （可选，延后）新建 `web-alpha` profile，按第 6 节逐插件适配 alpha | alpha profile 全功能回归 |

## 6. 当前已安装插件：alpha.1 升级影响评估

评估对象：`~/.dsh/profiles/web` 当前实际加载的插件（package.json bundles + cordis.patch hot patches）。
结论分级：🔴 高（不处理会坏）/ 🟡 中（需回归）/ 🟢 低。

| 插件 | 版本 | 关键风险点 | 评估 |
|---|---|---|---|
| `@deepseek-ai/dsh-plugin-weave` | local `K:\work\project\weave` | `sessionKey/weave` 经 `ctx.subagents.start` 透传；任务/团队模块自研 | 🔴 必须先按本文 P0–P8 改造 |
| `@dsh-external/dsh-diff-viewer` | 0.1.0 | `dsh.client.inject` 含已移除的 `@deepseek-ai/dsh-client-runtime` | 🔴 客户端注入失败 |
| `@dsh-external/dsh-drag-and-drop` | 0.1.2 | 同上，还注入 `dsh-client-ui-conversation` | 🔴 客户端注入失败 |
| `@dsh-external/dsh-share` | 0.1.0 | 注入 `dsh-client-runtime` + `ui-conversation` + `ui-primitives` | 🔴 客户端注入失败 |
| `@dsh-external/dsh-mobile` | 0.1.0 | 注入 `dsh-client-runtime` + `ui-layout` | 🔴 移动端 UI 会坏 |
| `@dsh-external/dsh-super-injector` | 0.3.3 | 注入 `dsh-client-runtime` + `ui-slots` | 🔴 注入器客户端会坏 |
| `dsh-opencode-go-usage` | 0.1.0 | 注入 `dsh-client-runtime` + `dsh-api-remotes`；API 端点改斜杠 | 🔴 大概率坏 |
| `@nanmicoder/dsh-agent-teams` | 0.1.7 | **当前未挂载**，仅 pnpm-lock 残留；若启用，注入 `dsh-client-runtime` | 🔴 计划用 fork 替换 |
| `api-balance` | 0.2.1 | 仅注入 `dsh-client-ui-slots`；需回归 labels / 设置页变化 | 🟡 升级后回归 |
| `cleverer-dsh` | 1.2.0 | host-only 插件，依赖内部事件/steer/context；无 client 注入 | 🟡 升级后回归 |
| `@deepseek-ai/dsh-toolkit` | 0.0.1 | host-only 工具包；peer `dsh-tools` 版本线变化 | 🟡 升级后回归 |
| 官方 `dsh-base` / `dsh-web-app` | 随 alpha 升级 | 官方随版本同步 | 🟢 随 alpha 一起替换 |

### 6.1 升级前的硬性前置

1. 凡注入 `@deepseek-ai/dsh-client-runtime` 的插件，必须先按 alpha 新注入面改造（该包已移除）。
2. `dsh-opencode-go-usage` 还需适配斜杠端点和参数包装。
3. weave 必须先完成本文 P0–P8，否则任务/团队/ACP 路径在 alpha 下不可用。
4. 当前 lock 中残留的 `@nanmicoder/dsh-agent-teams@0.1.7` 不要继续使用，直接由 fork 替代。

### 6.2 建议的升级验证方式

- 新建一个 `web-alpha` profile，不污染当前 `web` profile；
- 先只装官方 alpha bundle，逐插件加入并验证；
- 每加一个插件跑：启动成功 → 控制台 URL/token → 核心页面可开 → 插件功能点冒烟。

## 7. 公网映射 / 手机访问影响

### 7.1 结论

- **能继续用**，`trustedHosts` 机制在 alpha 保留。
- 但 alpha 的浏览器鉴权是：**一次性 process Token 换 authority-bound Cookie**。
- 因此公网访问从“打开干净 URL”变成：
  1. 从启动日志拿 token：
     ```
     dsh web: http://127.0.0.1:<port>/?token=<TOKEN> (LAN: http://<lan>/?token=<TOKEN>)
     ```
  2. 手机首次访问：
     ```
     https://47.102.120.125.sslip.io/?token=<TOKEN>
     ```
  3. 验证成功 → 303 跳转干净 `/`，并种下与该 authority 绑定的签名 Cookie；
  4. 之后手机直接访问 `https://47.102.120.125.sslip.io/` 即可，直到 Cookie 过期或清除。

### 7.2 必须保留/调整的配置

- 当前 `web` profile 的：
  ```yaml
  - id: web-runtime
    config:
      trustedHosts:
        - 47.102.120.125
        - 47.102.120.125.sslip.io
  ```
  在 alpha 必须保留，否则公网 authority 会先被 trust fence 403。
- `token` 只在进程启动时生成；手机 Cookie 丢失后，需要从新启动日志拿新 token。
- 签名密钥持久化在 Harness home；重启后旧 Cookie 仍有效（未过期时）。
- 不建议把 token 长期写死在书签/分享链接里；正确姿势是首次带 token 打开，之后靠 Cookie。

### 7.3 风险

- 如果手机浏览器/WebView 禁用或清理 Cookie，必须重新用 token URL 访问一次。
- 若公网映射会改写 `Host` 头（如部分 CDN/反代），需确保最终到达 DSH 的 `Host` 与 `trustedHosts` 匹配；否则 403。
- 远程访问仍是明文 HTTP 语义下的浏览器信任边界，建议后续评估是否在反代层加 TLS 终结 + 固定 Host。

## 8. 升级策略：rc.2 主线 + alpha 预研线

### 8.1 主线（现在做）

- DSH 版本：`0.1.1-rc.2`
- 目标：fork dsh-agent-teams，完成团队配置 / 会话建队 / 知识 / 反思 / ACP / fork 子代理全部集成
- 现有插件：**零影响**，当前 web profile 不用动
- 验证环境：现有 web profile + weave 测试体系

### 8.2 预研线（延后做）

- DSH 版本：`v0.1.2-alpha.1`（本地源码已 clone）
- 目标：独立 `web-alpha` profile，逐插件适配第 6 节风险项
- 触发时机：插件适配完成 / alpha 发布 npm / 必须使用 alpha 独有能力

### 8.3 两条线的关系

- fork 的 `MemberTransport` 抽象必须一开始就设计成与 DSH 版本解耦：
  - rc.2 下走当前 `ctx.subagents` 能力
  - alpha 下走 childId / subagent/end / 标准 ACP 能力
- 先 rc.2 交付功能，再 alpha 做能力增强，不在同一窗口并行改。
