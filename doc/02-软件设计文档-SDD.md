# Weave 软件设计文档（SDD）

| 元信息 | 内容 |
| --- | --- |
| 文档版本 | v0.2.0 |
| 日期 | 2026-08-24 |
| 状态 | 正式版 · Phase 0 开发基线 |
| 上游依据 | `doc/架构设计文档.md` v0.2.0（含附录 C 知识导入与角色学习决策） |
| 覆盖范围 | 总体架构、模块划分、技术选型、数据流、数据模型、错误处理、部署形态、ADR |
| 第 2 轮修订 | 2026-08-25：按《doc/review-report-round1.md》§2 实证事实 E2-E5 对齐真实 DSH 0.1.1-rc.2 `ctx.subagents` API 契约（§2.3.3/2.3.5、§2.4.2、§5.4、§6.1、§6.3） |

---

## 1 总体架构

### 1.1 文档定位

本文档是 Weave v0.2.0 的软件设计文档（SDD），面向研发、测试、架构评审与后续维护人员。内容以架构设计文档 v0.2.0 为基线，并将附录 C 中关于知识导入、AnyDoc、Graphify、Obsidian 的决策落实到可设计、可实现的模块边界与接口定义。

核心对齐点：

- 执行器调用基于 DSH 原生 `ctx.subagents` API，删除自研进程管理与 `SessionLifecycleManager`；
- 执行器收敛为四类：DSH 子代理 / Codex / Claude Code / 其它 ACP 协议工具；
- 保温期修订依赖 `SessionTracker` 注入“上一版输出 + 用户反馈”到新 prompt；
- 知识导入以 Web 界面为主，AnyDoc 统一转换为 GitHub-Flavored Markdown；
- AnyDoc、Graphify、Obsidian 是知识导入、转换、浏览能力，不是执行器。

### 1.2 架构分层

```text
┌─────────────────────────────────────────────────────────────┐
│                         用户入口                            │
│  DSH 会话 / Codex / ZCode / 自研 Agent / CLI / Web / MCP     │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                   DSH（微内核 + Cordis 插件系统）             │
│                                                              │
│  基础能力：插件生命周期 / DI / 事件总线 / 会话管理 / HTTP /  │
│            CLI / MCP Server / ctx.subagents 原生子代理管理   │
│                                                              │
│  Weave 插件：                                               │
│    TeamManager / Orchestrator / FeedbackRouter              │
│    DelegationService / SessionTracker / ExecutorRegistry    │
│    KnowledgeEngine / ReflectionEngine / CircuitBreaker      │
│    ProcessLimiter / SingleWriterQueue / ImportPipeline      │
└──────────────────────────────┬──────────────────────────────┘
                               │ ctx.subagents.start
┌──────────────────────────────▼──────────────────────────────┐
│        执行器（真正的“手和脚”）                                │
│  ① DSH 子代理：spawn / fork / 自定义 provider                │
│  ② Codex：dsh-subagent-codex                                 │
│  ③ Claude Code：dsh-subagent-claude-code                     │
│  ④ 其它 ACP 工具：dsh-subagent-acp（zcode 等）                │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 核心设计原则

| 原则 | 说明 |
| --- | --- |
| DSH 原生 | Weave 是 DSH 插件，优先复用 DSH 能力 |
| 统一子代理 | 所有执行器通过 `ctx.subagents` 统一调用 |
| 核心无 LLM | P0 调度、校验、路由采用规则驱动 |
| 一切皆配置 | 团队、角色、执行器、知识注入均通过 YAML 定义 |
| 文件优先 | 知识以 Markdown + YAML frontmatter 存储 |
| 渐进成长 | 知识先 `candidate` 后 `active` |
| 人工优先 | 人工修订单向 `supersede` |
| 知识会老 | `freshness_score` 支持时间衰减 |
| 任务可迭代 | 保温期 + 修订上下文注入 |
| 无侵入 | 执行器无需感知 Weave |
| 资源由 DSH 管 | Weave 不自行 spawn/kill 进程，只跟踪状态 |

### 1.4 四大模块

| 模块 | 一句话职责 | 对应架构章节 |
| --- | --- | --- |
| TeamManager | 加载并校验团队/角色/执行器配置，回答“谁可以做、能做什么” | 4.1 |
| Orchestrator | 将用户任务规则化分解为 DAG，驱动状态机与依赖传播 | 4.2 |
| DelegationService | 通过 `ctx.subagents.start` 委托执行器执行任务，并注入上下文 | 5.2 |
| KnowledgeEngine | 维护四层知识、检索注入、接收任务沉淀 | 7 |

其余支撑模块包括：`SessionTracker`、`FeedbackRouter`、`CircuitBreaker`、`ProcessLimiter`、`SingleWriterQueue`、`ReflectionEngine`、`ImportPipeline`、`Graphify`、`Obsidian`。

### 1.5 执行器四类

| 类别 | 注册方式 | 调用方式 | 进程管理 | 会话保持 |
| --- | --- | --- | --- | --- |
| DSH 子代理 | DSH 内置 spawn/fork 或自定义 provider | `ctx.subagents.start('spawn'/'fork'/'...', request)` | DSH 内部 | ephemeral 线程 |
| Codex | `@deepseek-ai/dsh-subagent-codex` | `ctx.subagents.start('codex', request)` | DSH 内部 | 一次性 / 由 provider 决定 |
| Claude Code | `@deepseek-ai/dsh-subagent-claude-code` | `ctx.subagents.start('claude-code', request)` | DSH 内部 | 一次性 / 由 provider 决定 |
| 其它 ACP 工具 | `@deepseek-ai/dsh-subagent-acp` | `ctx.subagents.start('zcode'/'...', request)` | DSH 内部 | ACP 进程内驱动 |

**关键约束：**

- 所有执行器统一走 `ctx.subagents.start(executorId, request)`；
- `dsh-subagent-codex` 等创建 ephemeral 线程，任务完成后线程销毁；
- Weave 不自行维护跨任务会话，修订信息必须注入 prompt；
- 非交互模式下需要用户批准的操作由执行器自动拒绝，Weave 按正常返回映射 `permission_denied`。

### 1.6 知识导入与外部能力定位

| 能力 | 定位 | 优先级 | 是否执行器 |
| --- | --- | --- | --- |
| AnyDoc | 文档统一转换为 GFM Markdown | P0 | 否 |
| ImportPipeline | Web 导入 → 转换 → candidate → 审核 | P0 | 否 |
| Graphify | 知识图谱生成与查询 | P1 | 否 |
| Obsidian | 用户可见 Markdown Vault | P0 入口 / P1 双链增强 | 否 |

---

## 2 模块划分

### 2.1 TeamManager

#### 2.1.1 职责

- 加载 `~/.dsh/teams/{team_id}.yaml`；
- 解析角色、难度匹配器、DAG 模板、知识注入限制、反馈参数；
- 校验 `executor` 是否已在 `ExecutorRegistry` 中注册；
- 支持多团队优先级链：显式指定 > 会话绑定 > 默认团队 > 仅一个团队 > 提示选择；
- 向 `Orchestrator` 提供当前团队与角色配置。

#### 2.1.2 配置结构

```yaml
# ~/.dsh/teams/{team_id}.yaml
schema_version: "1"
team_id: alpha-squad
name: 阿尔法小队
default: true

roles:
  - id: designer
    name: 方案设计师
    bias: design
    executor: codex
    stages: [prepare, design]        # 该角色可执行的 DAG 阶段（HI-4）
    max_concurrent_tasks: 1
    personality: |
      你是方案设计师，注重简洁性和可扩展性。

  - id: coder
    name: 核心开发
    bias: dev
    executor: zcode
    stages: [implement, test, integrate, execute, deploy]
    max_concurrent_tasks: 2
    personality: |
      你追求代码质量和性能。

  - id: reviewer
    name: 代码审核
    bias: review
    executor: codex
    stages: [review]
    max_concurrent_tasks: 2
    personality: |
      你是严格的审核员，会给出建设性建议。

task_decomposition:
  matchers:
    - pattern: "重构|核心|关键|安全"
      difficulty: critical
    - pattern: "新增|实现|集成"
      difficulty: medium
    - pattern: "修复|调整"
      difficulty: easy
  dag_templates:
    easy: ["execute"]
    medium: ["design", "implement", "test"]
    hard: ["design", "implement", "review", "test", "integrate"]
    critical: ["prepare", "design", "implement", "review", "test", "deploy"]
  default_difficulty: hard            # HI-4：matcher 未命中时的兜底难度

knowledge_injection:
  max_entries: 5
  max_chars_per_entry: 500
  max_total_chars: 2500
  priority: freshness_first

feedback:
  feedback_timeout_seconds: 1800
  max_revisions: 5
  reopen_window_seconds: 86400

executor_limits:                      # ME-6：执行器级硬限制（键 = role.executor provider 名）
  codex:
    max_concurrent: 2
    max_per_hour: 20
  zcode:
    max_concurrent: 2
    max_per_hour: 20
```

#### 2.1.3 校验规则

| # | 校验项 | 失败行为 |
| --- | --- | --- |
| 1 | `schema_version = "1"` | 加载失败 |
| 2 | 角色 `id` 唯一 | 校验失败 |
| 3 | `executor` 已注册（DSH 子代理 / Codex / Claude Code / ACP provider） | 校验失败 |
| 4 | ~~非 P0 自定义 CLI 命令存在于 PATH~~（LO-7：非 P0 行为，从 P0 团队校验移除；P0 仅校验 1-3、5-8 项） | 不适用（非 P0） |
| 5 | `max_concurrent_tasks > 0` | 校验失败 |
| 6 | 每角色 `stages` 非空；每模板阶段至少绑定一个角色（2.2.7，HI-4） | 校验失败 |
| 7 | `dag_templates[default_difficulty]` 存在；`pattern` 为合法正则（HI-4） | 校验失败 |
| 8 | `executor_limits` 的 `max_concurrent > 0`、`max_per_hour > 0`（ME-6） | 校验失败 |

#### 2.1.4 关键接口

```typescript
interface TeamConfig {
  team_id: string
  name: string
  default: boolean
  roles: RoleConfig[]
  task_decomposition: TaskDecomposition
  knowledge_injection: KnowledgeInjection
  feedback: FeedbackConfig
  /** 执行器级限流（ME-6）；键 = role.executor；缺省 { max_concurrent: 1, max_per_hour: 20 } */
  executor_limits?: Record<string, ExecutorLimit>
}

class TeamManager {
  async loadTeam(teamId: string): Promise<TeamConfig>
  async listTeams(): Promise<TeamConfig[]>
  /** null = 需用户显式选择（多团队无绑定无默认）；调用方提示后 team_switch 绑定（ME-4） */
  async selectTeam(sessionId: string, explicit?: string): Promise<TeamConfig | null>
  async validateTeam(team: TeamConfig, executorRegistry: ExecutorRegistry): Promise<void>
}

- `selectTeam` 优先级链：显式指定 > 会话绑定（`team_bindings`，ME-4）> 默认团队 > 仅一个团队（自动）> 提示选择（返回 `null`）；
- `team_switch` 将绑定 UPSERT 到 `core.db.team_bindings`（DDL 见 5.2）。
```

### 2.2 Orchestrator

#### 2.2.1 职责

- 接收用户任务；
- 按 `task_decomposition.matchers` 匹配难度；
- 根据 `dag_templates` 生成任务 DAG；
- 维护 14 态任务状态机和 32 条转移；
- 处理失败传播与 `SKIPPED` 重激活；
- 生成全局唯一、连续的任务 ID。

#### 2.2.2 规则驱动分解

| 难度 | 匹配模式 | 默认 DAG |
| --- | --- | --- |
| easy | 修复、调整 | `execute` |
| medium | 新增、实现、集成 | `design → implement → test` |
| hard | 复杂需求 / **matcher 未命中兜底**（default_difficulty，HI-4） | `design → implement → review → test → integrate` |
| critical | 重构、核心、关键、安全 | `prepare → design → implement → review → test → deploy` |

- matcher 多命中取最高难度（critical > hard > medium > easy）；未命中 → `default_difficulty`（缺省 `hard`）——HI-4；
- 阶段→角色绑定规则见 2.2.7。

#### 2.2.3 任务状态机

```text
| # | 当前 → 目标 | 触发 | 说明 |
| --- | --- | --- | --- |
| 1 | WAITING → BLOCKED | 依赖检查：上游未全部到成功终态 | 上游完成/失败时由传播规则（2.2.4）重估 |
| 2 | BLOCKED → WAITING | 依赖全部满足（或上游被 override） | 进入就绪队列 |
| 3 | WAITING → RUNNING | runReadyTasks 派发（角色软限制 + 执行器槽位） | 角色已绑定（见 2.2.7） |
| 4 | RUNNING → COMPLETED | stopReason=completed | 写 result；随后自动进入 AWAITING_FEEDBACK（#10） |
| 5 | RUNNING → FAILED | 按错误映射（error/max-tokens/refusal/基础设施 reject/timeout/可选 permission_denied） | 写 error_type；计熔断 |
| 6 | RUNNING → BANNED | 断路器触发（连续失败 ≥ 3） | 计熔断；后续 #20/#21 |
| 7 | RUNNING → LOOP_TERMINATED | 循环检测命中 | 计熔断（循环防护） |
| 8 | RUNNING → INTERRUPTED | 外部中断（非用户取消） | 可恢复（#26）或取消 |
| 9 | RUNNING → CANCELLED | 用户取消 | 不计熔断；stopReason=aborted |
| 10 | COMPLETED → AWAITING_FEEDBACK | 自动进入保温期 | feedback_expires_at = now + 1800s |
| 11 | AWAITING_FEEDBACK → REVISION_RUNNING | 用户 revise | revision_count+1；recordRevision；保温期重置 |
| 12 | AWAITING_FEEDBACK → CLOSED | accept 或保温期超时 | clearRevision；写 closed_at |
| 13 | AWAITING_FEEDBACK → CANCELLED | 用户 cancel | 终态，参与失败传播 |
| 14 | REVISION_RUNNING → COMPLETED | 修订委托完成 | 写 result；保温期重置 |
| 15 | REVISION_RUNNING → FAILED | 修订失败/超时（ME-5） | previous_result 保留；revision_count 不回退；可 #18 retry |
| 16 | REVISION_RUNNING → CANCELLED | 修订取消（ME-5） | 不计熔断；上下文保留 |
| 17 | CLOSED → AWAITING_FEEDBACK | reopen（24h 窗口内） | reopen_count+1；保温期重置 |
| 18 | FAILED → WAITING | retry | 失败计数保留（断路器侧） |
| 19 | FAILED → SKIPPED | skip | skip_override=1 |
| 20 | BANNED → COOLDOWN | 冷却开始（expiry/手动解除） | 记录 cooldown_seconds |
| 21 | BANNED → SKIPPED | skip（熔断下） | skip_override=1 |
| 22 | COOLDOWN → WAITING | 冷却结束 | 可再次派发 |
| 23 | COOLDOWN → SKIPPED | 冷却期间 skip | skip_override=1 |
| 24 | LOOP_TERMINATED → WAITING | retry | — |
| 25 | LOOP_TERMINATED → SKIPPED | skip | — |
| 26 | INTERRUPTED → WAITING | retry | — |
| 27 | INTERRUPTED → SKIPPED | skip | — |
| 28 | INTERRUPTED → CANCELLED | cancel | 终态 |
| 29 | CANCELLED → WAITING | retry | 终态恢复（用户显式） |
| 30 | CANCELLED → SKIPPED | skip | — |
| 31 | WAITING → CANCELLED | cancel（等待中） | — |
| 32 | BLOCKED → CANCELLED | cancel（阻塞中） | — |

> 权威矩阵（含前置条件与副作用分列）见 TDD §2.1.5。`COOLDOWN` 为第 14 态：唯一路径 BANNED → COOLDOWN → WAITING（或人工 COOLDOWN → SKIPPED）。失败终态 FAILED/BANNED/LOOP_TERMINATED/CANCELLED 触发下游 SKIPPED 传播；SKIPPED 为吸收态（重激活由 reactivateSkipped 恢复，迭代保护 100 次）；修订失败见 #15/#16（ME-5）。

```

失败终态：`FAILED / BANNED / LOOP_TERMINATED / CANCELLED`，触发下游 `SKIPPED` 传播。

#### 2.2.4 依赖失败传播与重激活

- 任一任务进入失败终态后，所有 `WAITING/BLOCKED` 下游置为 `SKIPPED`，迭代直到无变化；
- 上游 retry/skip 后，非 `override` 的 `SKIPPED` 下游恢复 `WAITING/BLOCKED`；
- 重激活迭代保护上限为 100 次；
- `skip_override` 用于标记人工强制跳过，不随上游恢复；
- **修订失败（ME-5）**：`REVISION_RUNNING → FAILED`（#15，计熔断）后保留修订上下文（`feedback_routes.previous_result`、`user_feedback`、`revision_count` 不回退），retry（#18）后重新执行修订注入；`REVISION_RUNNING → CANCELLED`（#16，不计熔断）同理。

#### 2.2.5 全局任务 ID

单事务原子操作：

```text
UPSERT task_sequences 获取连续序号 → 批量 INSERT tasks → commit
```

#### 2.2.6 关键接口

```typescript
class Orchestrator {
  async submitTask(input: SubmitTaskInput): Promise<TaskDag>
  async getDag(dagId: string): Promise<TaskDag>
  async runReadyTasks(team: TeamConfig): Promise<void>
  async propagateFailure(taskId: string): Promise<void>
  async reactivateSkipped(taskId: string): Promise<void>
}

- `submitTask`：`dags`/`tasks`（含 `dag_id`/`stage`）/`edges` 单事务写入（见 5.2）；`getDag` 三表联合读取（HI-3）；
- `runReadyTasks`：`WAITING` 且依赖满足的任务按 `task.stage → role.stages` 绑定角色（2.2.7）；角色级软限制（`max_concurrent_tasks`，ME-3）与执行器级硬限制（`executor_limits`，ME-6）独立叠加。
```

#### 2.2.7 阶段 → 角色绑定与 matcher 兜底（HI-4）

- 角色新增必填字段 `stages: string[]`：该角色可执行的 DAG 阶段名集合（RoleConfig，见 5.3）；
- 绑定：对模板中每个阶段 `s`，按 `roles` 声明顺序取第一个 `s ∈ role.stages` 的角色；结果写入 `tasks.assigned_agent`（**角色 id**；执行器 id 经 `role.executor` 解析，LO-9 术语澄清）与 `tasks.stage`；
- 兜底：无角色声明 `s` 时按“阶段名 = 角色 id”隐式匹配；仍无 → DAG 构建失败（`configuration_error`，不静默跳过）；
- matcher 未命中 → `default_difficulty`（缺省 `hard`）；多命中取最高难度（critical > hard > medium > easy）；
- `TeamManager.validateTeam` 校验：每角色 `stages` 非空、每模板阶段至少绑定一个角色、`dag_templates[default_difficulty]` 存在。

### 2.3 DelegationService

#### 2.3.1 职责

- 根据角色配置和 `ExecutorRegistry` 获取目标执行器；
- 执行进程数限流（获取/释放 slot）；
- 调用 `KnowledgeEngine.searchForInjection` 获取可注入知识；
- 调用 `SessionTracker.getRevisionContext` 获取修订上下文；
- 构建完整委托 prompt；
- 调用 `ctx.subagents.start` 并映射返回结果。

#### 2.3.2 依赖

```typescript
class DelegationService {
  constructor(
    private ctx: Context,
    private executorRegistry: ExecutorRegistry,
    private sessionTracker: SessionTracker,
    private processLimiter: ProcessLimiter,
    private knowledgeEngine: KnowledgeEngine,
  ) {}
}
```

#### 2.3.3 执行流程

```typescript
async executeTask(
  task: TaskRecord,
  role: RoleConfig,
  team: TeamConfig,
  context: TaskContext,
  cancelSignal: AbortSignal,
): Promise<SubagentTaskOutput> {
  const executorInfo = this.executorRegistry.get(role.executor)
  if (!executorInfo) {
    throw new WeaveError('executor_unavailable')
  }

  if (!this.processLimiter.acquire(role.executor)) {
    await this.waitForProcessSlot(role.executor, cancelSignal)
  }

  try {
    const knowledge = await this.knowledgeEngine.searchForInjection({
      taskId: task.id,
      projectId: task.project_id,
      version: task.version,
      roleId: role.id,
      limit: team.knowledge_injection,   // ME-2：团队级注入限制（P0 无角色级覆盖）
    })

    const revisionContext = await this.sessionTracker.getRevisionContext(task.id)
    const prompt = this.buildPrompt(task, role, context, knowledge, revisionContext)

    // DSH 契约（0.1.1-rc.2）：prompt 为 ContentBlock[]，parent/signal 必填；cwd 由 DSH 解析
    const startedAt = Date.now()
    const run = await this.ctx.subagents.start(role.executor, {
      prompt: [{ type: 'text', text: prompt }],
      parent: context.parentAgent,
      signal: cancelSignal,
    })

    // 子代理失败时 run.result resolve（stopReason='error'），不 reject；仅基础设施故障 reject
    const result = await run.result
    const durationMs = Date.now() - startedAt

    return this.mapResult(run, result, durationMs)
  } finally {
    this.processLimiter.release(role.executor)
  }
}
```

#### 2.3.4 委托 Prompt 构建

```text
你是 {role_name}，负责完成以下任务。

## 角色人格
{personality}

## 任务描述
{task_description}

## 项目上下文
- 项目: {project_id} - 版本: {version}
- 工作目录: {repo_path}
- Git 分支: {git_branch}

## 上游任务产物
{dependency_artifacts}

## 相关知识（来自知识库）
{relevant_knowledge}

[若为修订任务：]
## 之前的版本与用户反馈
这是第 {n} 次修订。
### 上一版输出
{previous_result 摘要}
### 用户反馈历史
1. {feedback_1}
2. {feedback_2}

## 可用命令（执行中可调用）
- （P0 阶段无知识检索 CLI；`/weave knowledge search` 属 P1，不在执行器可用命令中）

## 知识沉淀要求
### WEAVE_KNOWLEDGE_START
{"type": "pitfall", "title": "...", "content": "...", "tags": ["..."]}
### WEAVE_KNOWLEDGE_END

## 输出要求
{output_requirements}
```

**说明：**

- `prompt` 最终以 `ContentBlock[]`（`[{ type: 'text', text: prompt }]`）传入 `ctx.subagents.start`（真实 DSH 0.1.1-rc.2 契约，`SubagentStartRequest.prompt` 非 `string`）；
- `parent: Agent` 与 `signal: AbortSignal` 为必填；
- `cwd` 由 DSH 从 parent session 工作目录解析，Weave 不显式传入；
- 因为 ephemeral 线程无跨任务记忆，修订必须注入完整上下文；
- prompt 中的知识注入需遵守 `max_entries`、`max_chars_per_entry`、`max_total_chars`。

#### 2.3.5 结果映射（第 2 轮修订）

`DelegationService` 将 DSH 返回的 `SubagentRun`（`{ id, localAgent?, result: Promise<SubagentResult>, dispose() }`）与 `SubagentResult`（`{ output: ContentBlock[], structured?, diagnostic?, stopReason }`）统一转换为 Weave 内部结果 `SubagentTaskOutput`：

```typescript
type SubagentTaskOutput = {
  id: string                   // run.id（父子代理运行 id）
  output: ContentBlock[]       // result.output（子代理最终 assistant 内容；空时 []）
  structured?: unknown         // result.structured（仅当请求 outputSchema 且成功）
  diagnostic?: string          // result.diagnostic（非 completed 时的失败细节，≤4096B）
  stopReason: SubagentStopReason // completed / aborted / error / max-tokens / refusal
  duration_ms: number          // Weave 自计时（start() → result 完成）；DSH API 不提供
}
```

- 子代理以失败终止时 `run.result` **resolve**（`stopReason='error'`），不 reject；仅 DSH 无法表示的基础设施故障才 reject（按基础设施故障映射，见 6.1）；
- `stopReason → 任务终态/错误码` 映射见第 6 节；
- 取消：`cancelSignal` 直达 DSH（终止为 `aborted`）；主动放弃已发布运行调用 `run.dispose()`（幂等）。

### 2.4 ExecutorRegistry

#### 2.4.1 职责

- 通过 `ctx.subagents.list()` 发现 DSH 已注册的全部 subagent provider；
- 自动分类为 `dsh_subagent / codex / claude_code / acp`；
- 为 `TeamManager` 提供执行器存在性校验；
- 为 `DelegationService` 提供执行器信息查询；
- 为 Web/CLI 提供执行器列表展示。

#### 2.4.2 类型与接口

```typescript
import type { SubagentCapabilities } from '@deepseek-ai/dsh-subagent'

type ExecutorKind =
  | 'dsh_subagent'
  | 'codex'
  | 'claude_code'
  | 'acp'

interface ExecutorInfo {
  id: string
  name: string
  kind: ExecutorKind
  /** 真实 DSH SubagentCapabilities（outputSchema / depthLimit / toolFilter / persona） */
  capabilities: SubagentCapabilities
}

class ExecutorRegistry {
  private executors: Map<string, ExecutorInfo> = new Map()

  load(ctx: Context): void {
    // ctx.subagents.list() 为同步方法（0.1.1-rc.2）
    const providers = ctx.subagents.list()
    for (const provider of providers) {
      const kind: ExecutorKind =
        provider === 'codex'          ? 'codex'
        : provider === 'claude-code'  ? 'claude_code'
        : provider === 'spawn' || provider === 'fork' ? 'dsh_subagent'
        : /* 其它通过 ACP 注册的外部工具 */ 'acp'

      const providerInfo = ctx.subagents.getProvider(provider)
      this.executors.set(provider, {
        id: provider,
        name: provider,
        kind,
        capabilities: providerInfo?.capabilities
          ?? { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      })
    }
  }

  get(id: string): ExecutorInfo | undefined
  list(): ExecutorInfo[]
  kindOf(id: string): ExecutorKind | undefined
}
```

> 说明（第 2 轮修订）：`capabilities` 读取真实 `SubagentCapabilities`（`ctx.subagents.getProvider(name).capabilities`）；原 `supports_feedback_loop / non_interactive / ephemeral_session`（全同常量、无数据源）已删除。
> 消费方（LO-8）：执行器页 / `GET /weave/executors` 展示 provider 能力；其余模块 P0 不消费该字段。

#### 2.4.3 分类依据

| provider 值 | 分类 |
| --- | --- |
| `spawn` / `fork` / 自定义 DSH provider | `dsh_subagent` |
| `codex` | `codex` |
| `claude-code` | `claude_code` |
| 其它 ACP 工具 | `acp` |

#### 2.4.4 与团队校验的集成

`TeamManager.validateTeam()` 遍历每个角色的 `executor` 字段，调用 `executorRegistry.get(executor)`；若不存在，则团队加载失败，并在 Web/CLI 中返回明确错误。

### 2.5 KnowledgeEngine

#### 2.5.1 职责

- 维护四层知识体系：项目 / 角色 / 实例 / 全局；
- 维护 `_agent / _human / _views` 三目录隔离；
- 支持 Markdown + frontmatter 知识条目；
- 实现知识生命周期：`candidate → active → deprecated | superseded`；
- 维护置信度、`freshness_score`；
- 为 `DelegationService` 提供 `searchForInjection()`；
- 解析执行器输出中的 `WEAVE_KNOWLEDGE` 标记并沉淀 candidate。

#### 2.5.2 四层知识与目录

| 层级 | 目录 | 可见性 |
| --- | --- | --- |
| 项目知识 | `_agent/projects/{project}/{version}/` | 项目内 |
| 角色知识 | `_agent/roles/{role}/` | 同角色 |
| 实例知识 | `_agent/instances/{instance}/` | 仅实例 |
| 全局知识 | `_agent/shared/` | 全员 |

```text
knowledge/
├── _agent/    # Agent 写入区
├── _human/    # 人工编辑区
└── _views/    # 动态视图
```

#### 2.5.3 知识条目格式

```markdown
---
schema_version: "1"
title: gRPC 级联超时踩坑记录
type: pitfall
status: candidate
confidence: 0.1
created: 2026-08-24
freshness_score: 1.0
visibility: project_only
tags: [gRPC, 超时]
---

正文内容...
```

#### 2.5.4 生命周期与置信度

```text
candidate → active → deprecated | superseded
```

- 初始置信度：`0.1`
- 成功复现：`+0.15`
- 失败：`-0.15`
- 转正阈值：`0.75`
- 范围：`clip(0, 1)`

#### 2.5.5 知识保鲜

| 层 | 机制 |
| --- | --- |
| 1 | 时间衰减 |
| 2 | 运行时校验 |
| 3 | 后台巡检 |
| 4 | 冲突替代 |

#### 2.5.6 检索权重

| 来源 | 权重 |
| --- | --- |
| 当前版本项目知识 | `1.0 × freshness` |
| 跨版本共享项目知识 | `0.9 × freshness` |
| 实例知识 | `0.85 × freshness` |
| 角色知识（同项目） | `0.8 × freshness` |
| 全局知识 | `0.6 × freshness` |
| 角色知识（跨项目） | `0.4 × freshness` |
| 其他版本项目知识 | `0.3 × freshness`（默认不参与） |

#### 2.5.7 注入限制

```yaml
knowledge_injection:
  max_entries: 5
  max_chars_per_entry: 500
  max_total_chars: 2500
  priority: freshness_first
```

每次委托前调用：

```typescript
async searchForInjection(input: {
  taskId: string
  projectId: string
  version: string
  roleId: string
  limit: KnowledgeInjection
}): Promise<KnowledgeHit[]>
```

#### 2.5.8 知识回流

- 执行器输出中包含 `WEAVE_KNOWLEDGE_START` / `WEAVE_KNOWLEDGE_END` 标记；
- `KnowledgeEngine` 解析 JSON 块；
- 生成 `status: candidate` 知识卡片；
- 进入审核队列，不直接成为 `active`。

### 2.6 ImportPipeline

#### 2.6.1 定位

知识导入是角色学习和知识库建设的 P0 入口。按附录 C.1，以 Web 界面操作为主，CLI/MCP 仅作自动化补充。

#### 2.6.2 支持类型

```text
DOC(`.doc`) / DOCX(`.docx`) / PDF(`.pdf`) / PPT(`.ppt`, `.pptx`) / Excel(`.xls`, `.xlsx`) / EPUB(`.epub`) / CSV(`.csv`) / RTF(`.rtf`) / ODT(`.odt`)  // LO-6
```

后续新增类型通过 AnyDoc 转换器扩展，不改业务入口。

#### 2.6.3 流程

```text
用户上传/拖拽文件
  → 格式白名单校验
  → AnyDoc 转换为 GitHub-Flavored Markdown
  → 提取标题 / 正文 / 标签 / 归属
  → 生成 candidate 知识卡片
  → 用户预览、编辑、确认
  → 进入审核队列
  → （P1）审核通过后 candidate → active
```

#### 2.6.4 归属选择

| 归属 | 字段 | 说明 |
| --- | --- | --- |
| 项目 | `project_id + version` | 项目与版本隔离 |
| 角色 | `role_id` | 注入到同角色任务 |
| 实例 | `instance_id` | 仅实例可见 |
| 全局 | `shared` | 全员可见 |

每个 candidate 必须带：

```yaml
schema_version: "1"
type: pitfall | pattern | doc | ...
status: candidate
confidence: 0.1
created: 2026-08-24
freshness_score: 1.0
visibility: project_only | role_only | instance_only | global
tags: []
```

#### 2.6.5 AnyDoc 边界

- **唯一选型：`@firecrawl/anydoc`**（`dsh-plugin-anydoc` 不作为 Phase 0 选项；后续若出现独立 DSH 插件封装包，仅作扩展另行评估）；
- 输出统一 GitHub-Flavored Markdown（GFM）；
- 图片/资源按 AnyDoc 能力转为引用路径或附件，P0 不保证复杂版式还原；
- **AnyDoc 不是执行器**：不通过 `ctx.subagents.start` 调用，不进入执行器限流；
- 安全要求：导入时不执行文件内宏/脚本，仅做文档解析。

#### 2.6.6 关键接口

```typescript
interface ImportPipeline {
  upload(file: UploadedFile, meta: ImportMeta): Promise<ImportJob>
  convert(jobId: string): Promise<ConvertResult>
  preview(jobId: string): Promise<{ markdown: string; warnings: string[] }>  // LO-5：与 HTTP /preview 一致
  confirm(jobId: string, edited: KnowledgeCandidate): Promise<string>
  cancel(jobId: string): Promise<void>
}
```

#### 2.6.7 错误处理

- 不支持的文件类型：Web 界面提示；
- 转换失败：记录错误并展示可读原因；
- 未确认前不写入 active 知识库；
- 转换失败不污染知识目录，临时文件隔离在 job 工作目录。

### 2.7 Graphify

#### 2.7.1 定位（P1）

按附录 C.4，Graphify 是知识图谱引擎，属于 P1，与 AnyDoc 不冲突。

- 输入：项目目录 / 知识目录；
- 输出：`graph.json`、`graph.html`、Obsidian Vault；
- Weave 使用 Cytoscape.js 展示图谱；
- 支持 `query / path / explain`。

#### 2.7.2 功能清单

| 功能 | 说明 |
| --- | --- |
| 图谱生成 | 扫描 Markdown 知识、frontmatter、`[[双链]]` 关系 |
| 图谱展示 | Cytoscape.js 渲染节点/边 |
| 查询 | 按关键词/标签/类型查询节点 |
| 路径 | 展示两节点间路径 |
| 解释 | 解释某条边/节点的来源依据 |

#### 2.7.3 边界

- Graphify 不是执行器；
- P0 不构建 Graphify；
- P0 不做浏览器采集与链接导入。

### 2.8 Obsidian

#### 2.8.1 存储兼容

知识主存储保持 Markdown + frontmatter，天然兼容 Obsidian：

```text
~/.dsh/obsidian/
```

作为用户可见 Vault。

#### 2.8.2 P0 能力

- “打开 Obsidian”入口；
- 打开 `~/.dsh/obsidian/`；
- P0 不做双向同步；
- 手动编辑 Obsidian 中的文件不会被 Weave 自动覆盖。

#### 2.8.3 P1 增强

- 支持 `[[双链]]` 作为轻量知识关联；
- Graphify 将生成结果输出到 Obsidian Vault；
- 后续同步方案另行评估。

### 2.9 配套支撑模块

| 模块 | 职责 |
| --- | --- |
| SessionTracker | 记录修订上下文；替代 `SessionLifecycleManager`，不管理进程 |
| FeedbackRouter | 保温期反馈意图识别（accept / revise / cancel），超时关闭 |
| CircuitBreaker | 断路器状态机：ACTIVE → BANNED → COOLDOWN → ACTIVE |
| ProcessLimiter | 执行器级并发 + 小时频率硬限制（配置源 `team.yaml.executor_limits`，缺省 1/20），超限排队不熔断；角色级 `max_concurrent_tasks` 为调度软限制（ME-3/ME-6） |
| SingleWriterQueue | SQLite 所有写操作串行化 |
| ReflectionEngine | 双向反思：负向 Pitfall、正向 Pattern |

---

## 3 技术选型

| 组件 | 选择 |
| --- | --- |
| 底座 | DSH 0.1.1-rc.2（含 `ctx.subagents`） |
| 核心语言 | TypeScript |
| 执行器调用 | `ctx.subagents.start`（DSH 原生） |
| 进程管理 | DSH 内部 |
| 会话保持 | ephemeral 线程 + Weave 上下文注入 |
| 持久化 | SQLite + WAL + 单写者队列 |
| 知识存储 | Markdown + YAML frontmatter |
| 检索 | BM25 + jieba |
| UI | React 18 + Ant Design v5 + Cytoscape.js |
| 文档转换 | `@firecrawl/anydoc`（ME-9 唯一选型；`dsh-plugin-anydoc` 不作 Phase 0 选项） |
| 知识图谱 | Graphify（P1） |
| 知识浏览 | Obsidian Vault（P0 入口 / P1 双链） |

---

## 4 数据流

### 4.1 任务主流程

```text
用户提交任务（CLI / MCP / Web）
  → TeamManager 读取当前团队与角色
  → Orchestrator 匹配难度、构建 DAG、生成任务 ID
  → 任务进入 WAITING / BLOCKED
  → DelegationService 按依赖与角色执行
      ├─ ExecutorRegistry 获取执行器
      ├─ ProcessLimiter 获取 slot
      ├─ KnowledgeEngine 注入知识
      ├─ SessionTracker 注入修订上下文
      └─ ctx.subagents.start(executor, prompt)
  → 结果写回任务
  → 任务进入 AWAITING_FEEDBACK
  → FeedbackRouter 处理反馈
      ├─ accept → CLOSED
      ├─ revise → REVISION_RUNNING → 再次委托
      ├─ cancel → CANCELLED
      └─ 超时 → CLOSED
```

### 4.2 知识导入数据流

```text
文件上传/拖拽
  → ImportPipeline 白名单校验
  → AnyDoc 转换为 GFM Markdown
  → 生成 candidate
  → 用户预览/编辑/确认
  → 审核队列
  → candidate → active
  → KnowledgeEngine 检索可见
```

### 4.3 角色学习闭环

```text
team.yaml 定义角色
  → 导入项目文档 / 技能文档
  → AnyDoc 转 Markdown
  → candidate 知识卡片
  → 审核转正 active
  → 任务执行时 KnowledgeEngine 检索注入
  → 任务失败/高效产出 WEAVE_KNOWLEDGE 标记
  → 沉淀 Pitfall / Pattern candidate
  → 再次审核
```

### 4.4 执行器发现数据流

```text
Weave 启动 / DSH provider 注册变更
  → ExecutorRegistry.load()
  → ctx.subagents.list()
  → 按 provider 分类
  → 写入内存 Registry
  → TeamManager 校验角色 executor
  → Web / CLI 展示执行器列表
```

### 4.5 持久化写入数据流

```text
业务写操作
  → SingleWriterQueue
  → SQLite WAL
  → tasks / feedback_routes / knowledge_meta / core.db
  → 审计日志
  → 崩溃恢复后状态一致
```

---

## 5 数据模型

### 5.1 顶层目录结构

```text
~/.dsh/
├── executors.yaml
├── teams/
├── knowledge/
│   ├── _agent/{projects,roles,instances,shared}/
│   ├── _human/
│   └── _views/
├── state/
│   ├── tasks.db
│   ├── core.db
│   ├── feedback.db
│   ├── knowledge_meta.db
│   └── imports.db
├── imports/                     # 导入任务/原始文件/转换中间产物（与架构 9.1 一致，ME-10）
├── anydoc-cache/                # AnyDoc 转换缓存（可清理）
├── audit/
├── obsidian/
└── graphify-out/                # P1：Graphify 产物；P0 不创建（ME-10）
```

### 5.2 核心数据表

```sql
-- tasks.db
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    dag_id TEXT NOT NULL,          -- 所属 DAG（HI-3；与 dags.dag_id 一致）
    session_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    description TEXT NOT NULL,
    stage TEXT NOT NULL,           -- DAG 模板阶段名（HI-4，阶段→角色绑定用）
    dependencies TEXT DEFAULT '[]',
    assigned_agent TEXT,
    executor TEXT,
    status TEXT NOT NULL,
    revision_count INTEGER DEFAULT 0,
    max_revisions INTEGER DEFAULT 5,
    feedback_timeout_seconds INTEGER DEFAULT 1800,
    feedback_expires_at TEXT,
    skip_override INTEGER DEFAULT 0,
    skip_reason TEXT,
    fail_count INTEGER DEFAULT 0,
    result TEXT,
    error_type TEXT,               -- DSH stopReason 或 Weave 应用层错误码（见 6.1）
    created_at TEXT,
    updated_at TEXT
);

-- dags/edges（HI-3）
CREATE TABLE dags (
    dag_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    difficulty TEXT NOT NULL,                    -- easy/medium/hard/critical
    status TEXT NOT NULL DEFAULT 'created',      -- created/running/completed/failed
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE edges (
    dag_id TEXT NOT NULL,
    from_task_id TEXT NOT NULL,
    to_task_id TEXT NOT NULL,
    PRIMARY KEY (dag_id, from_task_id, to_task_id)
);


-- feedback.db
CREATE TABLE feedback_routes (
    task_id TEXT PRIMARY KEY,
    executor_id TEXT NOT NULL,
    revision_count INTEGER DEFAULT 0,
    status TEXT,
    last_completed_at TEXT,
    closed_at TEXT,
    reopen_count INTEGER DEFAULT 0,
    user_feedback TEXT DEFAULT '[]',      -- JSON array
    previous_result TEXT                  -- 上一版输出摘要
);

-- knowledge_meta.db
CREATE TABLE knowledge_meta (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    layer TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence REAL DEFAULT 0.1,
    freshness_score REAL DEFAULT 1.0,
    last_confirmed TEXT,
    model_version TEXT,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);

-- core.db
CREATE TABLE task_sequences (
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    next_n INTEGER DEFAULT 1,
    PRIMARY KEY (project_id, version)
);

CREATE TABLE bans (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    reason TEXT,
    failed_count INTEGER DEFAULT 0,
    banned_at TEXT NOT NULL,
    expiry TEXT,
    cooldown_seconds INTEGER DEFAULT 0,
    state TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(scope, entity_key)
);

CREATE TABLE failure_counters (
    entity_key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    updated_at TEXT
);

-- 会话绑定（ME-4）
CREATE TABLE team_bindings (
    session_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

### 5.3 配置数据模型

- `team.yaml`：团队、角色、任务分解、知识注入、反馈配置；
- `executors.yaml`：非 P0 自定义 CLI 执行器（后备）；
- `knowledge` 文件：Markdown + frontmatter。

### 5.4 执行器信息模型

见 2.4.2 `ExecutorInfo`。`DelegationService` 只依赖该模型，不针对特定执行器写分支。

---

## 6 错误处理

### 6.1 错误类型与映射（第 2 轮修订）

真实 DSH 0.1.1-rc.2 的 `SubagentResult.stopReason` 枚举只有 `completed / aborted / error / max-tokens / refusal`（merge-extensible）。映射表：

| 来源 | error_type / 值 | 任务终态 | 计入熔断 |
| --- | --- | --- | --- |
| DSH `stopReason` | `completed` | COMPLETED | 否 |
| DSH `stopReason` | `aborted` | CANCELLED | 否 |
| DSH `stopReason` | `error` | FAILED | 是 |
| DSH `stopReason` | `max-tokens` | FAILED | 是 |
| DSH `stopReason` | `refusal` | FAILED | 是 |
| DSH `start()` 拒绝 / `run.result` 基础设施 reject | `execution_failed` | FAILED | 是 |
| Weave 应用层 | `timeout` | FAILED | 是 |
| Weave 应用层（可选启发式） | `permission_denied` | FAILED | 是 |
| Weave 应用层 | `executor_unavailable` | 委托前拦截 | 否 |

> 原 `cancelled / parse_failed / crash / unavailable` 映射取消：`cancelled` 由 `aborted` 承载；`parse_failed`（输出统一为 `ContentBlock[]`，无需解析为 stdout 文本）与 `crash`（表现为 `error` 或基础设施 reject）不再单列；`unavailable` 归入 `executor_unavailable`（委托前拦截，不计熔断）。

> 层级关系（ME-8）：本表为 `tasks.error_type` 的**持久化值域**；对外错误码见 TDD §1.1.2。交集项（`execution_failed`/`timeout`/`executor_unavailable`/`permission_denied`）同名同义；DSH stopReason 值（`aborted`/`error`/`max-tokens`/`refusal`）不对外暴露。

### 6.2 配置校验错误

- `team.yaml` 任一校验项失败：团队禁用；
- 错误信息必须包含文件路径、字段名、期望与当前值；
- `ExecutorRegistry` 未注册执行器时，`TeamManager` 返回 `executor_unavailable`。

### 6.3 执行器调用错误（第 2 轮修订）

- 执行器不存在 / provider 未注册：`WeaveError('executor_unavailable')`，委托前拦截，不进入熔断；
- `SubagentResult.stopReason ∈ { error, max-tokens, refusal }`：按 6.1 写入 `tasks.error_type`，计入断路器失败计数；
- `stopReason = aborted`：任务 `CANCELLED`，不计熔断（由用户取消 / cancelSignal / `run.dispose()` 产生；Weave 计时器超时除外——见下条）；
- Weave 应用层超时（委托计时器到期）：终止运行（触发 cancelSignal / `run.dispose()`），任务终态 FAILED 并计入熔断，`tasks.error_type='timeout'`；
- 非交互模式拒绝（可选启发式）：`result.output` / `result.diagnostic` 文本命中拒绝模式 → 任务 FAILED 计熔断；`tasks.error_type='permission_denied'` 仅作审计标记；未命中按 stopReason 正常映射；
- `run.result` 因基础设施故障 reject：任务 FAILED 计熔断。

### 6.4 知识导入错误

| 场景 | 处理 |
| --- | --- |
| 不支持的文件类型 | Web 界面提示，不创建 job |
| AnyDoc 转换失败 | 记录错误，展示可读原因 |
| candidate 保存失败 | 回滚临时文件 |
| 归属信息缺失 | 阻止确认并提示补全 |
| 文件包含脚本/宏 | 不执行，仅按文档解析 |

### 6.5 熔断与限流

- 断路器：连续失败 ≥ 3 → `BANNED`；到期/手动解除 → `COOLDOWN`；冷却结束 → `ACTIVE`；
- 检查顺序（最窄 scope 优先）：

```text
task → agent+project → agent → operation+project+version → operation+project → operation → global
```

- 循环检测：步数 30 / 工具重复连续 3 次 / 输出零增长连续 3 次 < 10 字符 / 时间限制 300s；
- 委托链防循环：深度 ≤ 3、executor 重复且未完成拒绝、等待超时 300s；
- 进程数限流：超限排队，不触发熔断。

### 6.6 崩溃恢复

- SQLite WAL + 单写者队列保证写一致性；
- 启动时扫描 `RUNNING / REVISION_RUNNING` 等中间态任务并修正；
- 审计日志保留状态变更轨迹。

---

## 7 部署形态

### 7.1 部署模型

- 单机单进程部署；
- Weave 作为 DSH 插件运行在 DSH 进程内；
- 所有状态保存在 `~/.dsh/`；
- 不依赖外部数据库或微服务。

### 7.2 DSH 插件安装

```text
DSH 插件生命周期管理（可逆副作用）
  → 注册 Weave 插件
  → 加载 TeamManager / Orchestrator / DelegationService / ExecutorRegistry
  → 初始化 SQLite 与单写者队列
  → 注册 CLI / MCP / Web 路由
  → ExecutorRegistry.load()
```

### 7.3 配置形态

- 团队：`~/.dsh/teams/{team_id}.yaml`；
- 非 P0 执行器：`~/.dsh/executors.yaml`；
- 知识：Markdown + frontmatter 文件；
- 状态：`~/.dsh/state/*.db`；
- 审计：`~/.dsh/audit/`；
- Obsidian Vault：`~/.dsh/obsidian/`。

### 7.4 对外接口

| 接口 | 说明 |
| --- | --- |
| CLI 命令 | `/weave team list/switch`、`/weave task submit/status/revise/accept/retry/skip/cancel/reopen`、`/weave dag <dag_id>`、`/weave knowledge search/review/approve/reject`、`/weave executor list`、`/weave ban list` |
| MCP Tools | `weave_submit_task`、`weave_get_status`、`weave_revise_task`、`weave_accept_task`、`weave_team_list`、`weave_team_switch`、`weave_knowledge_search`、`weave_knowledge_review` |
| HTTP/Web | `/weave/overview`、`/weave/tasks`、`/weave/knowledge`、`/weave/executors`、`/weave/sessions`、`/weave/audit`、`/weave/settings` |
| DSH 会话右侧面板 | 轻量 DAG 实时视图 |

### 7.5 可观测性

审计事件包括：

```text
task.status_changed
task.feedback_received
knowledge.status_changed
knowledge.superseded
ban.created / ban.resolved
team.switched
```

### 7.6 升级与回滚

- 配置、知识、数据库与插件代码同属一个 `~/.dsh` 目录，可整体备份；
- 升级前备份 `state/*.db` 与 `knowledge/`；
- DSH 插件支持可逆副作用，失败时回滚插件生命周期副作用；
- 知识文件保持 Markdown 格式，可被 Git/Obsidian 管理。

---

## 8 ADR

### 8.1 决策登记总览

| 编号 | 主题 | 状态 |
| --- | --- | --- |
| ADR-001 ~ ADR-029 | 与 v0.1.0-rc 相同的架构决策 | 已采纳 |
| ADR-030 | 执行器调用基于 DSH `ctx.subagents` 原生 API | 已采纳 |
| ADR-031 | ephemeral 线程下保温期修订靠上下文注入 | 已采纳 |
| ADR-032 | 删除自研进程管理和 SessionLifecycleManager | 已采纳 |
| ADR-033 | 执行器收敛为 DSH 子代理 / Codex / Claude Code / ACP 四类 | 已采纳 |

### 8.2 ADR-030：执行器调用基于 DSH ctx.subagents 原生 API

**背景：**

v0.1.0-rc 使用自研 `SubagentAdapter` 和进程管理，但 DSH 已原生提供 `ctx.subagents`。

**决策：**

Weave 通过 `ctx.subagents.start(executorId, request)` 调用执行器，不再自行管理进程。

**后果：**

- `DelegationService` 大幅简化；
- 进程生命周期由 DSH 保证；
- Weave 只跟踪状态与上下文，不负责 spawn/kill。

### 8.3 ADR-031：ephemeral 线程下保温期修订靠上下文注入

**背景：**

`dsh-subagent-codex` 每次调用创建临时线程，任务完成后线程销毁，无跨任务记忆。

**决策：**

Weave 在 `SessionTracker` 记录上一版输出与用户反馈，修订时注入新 prompt。

**后果：**

- 修订 prompt 更长，需要控制长度；
- 每次执行都携带完整上下文，保证无状态残留。

### 8.4 ADR-032：删除自研进程管理和 SessionLifecycleManager

**背景：**

DSH 原生 `ctx.subagents` 已覆盖子代理生命周期管理。

**决策：**

删除自研进程管理和 `SessionLifecycleManager`，用 `SessionTracker` 只做状态跟踪。

**后果：**

- 减少重复复杂度；
- 进程崩溃/取消统一由 DSH 处理；
- Weave 不承担进程恢复职责，只修正任务状态一致性。

### 8.5 ADR-033：执行器收敛为 DSH 子代理 / Codex / Claude Code / ACP 四类

**背景：**

v0.2.0 初稿曾把执行器分为“DSH 子代理插件”和“外部 CLI”，但 DSH 0.1.1-rc.2 的 `ctx.subagents` 并不直接支持任意 command 字符串。

**决策：**

执行器收敛为四类：

```text
DSH 子代理（spawn/fork/自定义 provider）
Codex
Claude Code
其它 ACP 协议工具
```

统一通过 `ctx.subagents.start(executorId, request)` 调用。自定义 CLI 仅作为非 P0 后备方案。

**后果：**

- `ExecutorRegistry` 只需基于 `ctx.subagents.list()` 分类；
- `DelegationService` 无需区分 source/command 分支；
- 外部工具支持 ACP 即可低成本接入；
- AnyDoc、Graphify、浏览器采集属于知识导入源/转换器，不是执行器。

---

> 本文档为 Weave v0.2.0 软件设计文档，与架构设计文档 v0.2.0、功能设计文档 FDD v0.2.0 保持一致，可作为 Phase 0 开发基线。
