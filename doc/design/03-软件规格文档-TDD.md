# Weave 软件规格文档（TDD/Spec）

> 本文档是 Weave v0.2.0 的软件规格 / 测试驱动开发（TDD）规格基座。
> 上游依据：《架构设计文档.md》v0.2.0（含附录 C）、《01-功能设计文档-FDD.md》、《02-软件设计文档-SDD.md》。

- 版本：v0.2.0
- 日期：2026-08-24
- 状态：Phase 0 开发基线
- 适用范围：DSH 插件形态的 Weave 协作层、知识导入管线、执行器接入、Web/CLI/MCP 外部接口
- 关键演进：基于 DSH 原生 `ctx.subagents`，删除自研进程管理；保温期修订依赖上下文注入；执行器收敛为 DSH 子代理 / Codex / Claude Code / ACP 四类；知识导入以 Web 界面为主，AnyDoc 统一转换，Graphify 为 P1，Obsidian 作为用户可见 Vault。
- 第 2 轮修订（2026-08-25）：按《doc/reports/review-report-round1.md》§2 实证事实 E2-E5 对齐真实 DSH 0.1.1-rc.2 `ctx.subagents` API 契约（§1.1.2 错误码、§1.5.3/1.5.4 接口签名、§2.1.2/2.1.4 error_type、§2.4 执行器模型、§4 AC-EXEC-001/004、§5.4 非交互模式）。
- 第 3 轮修订（2026-08-25）：按《doc/reports/review-report-round1.md》§3.2 HI-2/HI-3/HI-4、§3.3 ME-2/3/4/5/6/8、§3.4 LO-2 修订：新增 §2.1.5 权威状态转移矩阵（14 态 × 32 转移，含 COOLDOWN 处置、修订失败路径与迭代保护）；任务表增加 `dag_id`/`stage`，新增 `dags`/`edges`/`team_bindings` 表 DDL（§2.6.6-2.6.8）；角色新增 `stages` 字段与 DAG 阶段→角色绑定规则、matcher 兜底难度 `default_difficulty`（§1.5.2/§2.1.3/§2.3）；执行器限流配置 `executor_limits` 与角色级/执行器级分层限流（§1.5.9/§2.3）；`selectTeam` 会话绑定持久化与返回值语义（§1.5.1）；错误码层级关系（§1.1.2/§2.4.3）。

---

## 0 阅读指南

### 0.1 文档目标

1. 为 Phase 0 列出可测试、可落地的接口签名和数据模型规格。
2. 将附录 C 的“知识导入 / 角色学习 / Obsidian / Graphify”收敛为可实现的转换契约。
3. 提供验收规格（AC 列表），作为 TDD 测试用例编号、优先级和通过标准的来源。
4. 明确 v0.2.0 的兼容性约束，防止实现时倒退到自研进程管理或非四类执行器模型。

### 0.2 优先级约定

| 优先级 | 含义 |
| --- | --- |
| P0 | Phase 0 必须交付并测试；未通过则不得发布 |
| P1 | 后续阶段交付；P0 阶段仅保留接口占位或配置开关 |
| P1-P2 | 后续优化，允许接口扩展 |

### 0.3 一致性基线

- 数据 `schema_version` 统一为 `"1"`。
- 时间字段统一为 ISO 8601 字符串，如 `2026-08-24T12:00:00Z`；知识 frontmatter 的 `created` 为 ISO 8601 日期（`YYYY-MM-DD`），属于 ISO 8601 子集（LO-4）。
- ID 字符串统一使用 kebab-case / snake_case 稳定标识，不依赖操作系统路径作为业务主键外的唯一标识。
- 所有外部接口（MCP/CLI/HTTP）返回结构化 JSON；CLI 可同时输出人类可读文本或 `--json`。
- 错误码使用稳定枚举，见 1.1.2。

---

## 1 接口签名

### 1.1 通用约定

#### 1.1.1 命名规范

- MCP Tool：`weave_*`
- CLI：`/weave <domain> <verb> [options]`
- HTTP：`/weave/{domain}...`
- 内部服务：TypeScript class / interface，核心模块不依赖具体 UI。

#### 1.1.2 错误码

| 错误码 | 触发场景 |
| --- | --- |
| `executor_unavailable` | 角色绑定执行器未在 `ExecutorRegistry` 注册 |
| `invalid_team` | team.yaml 校验失败、团队不存在或切换失败 |
| `invalid_status_transition` | 请求触发了任务状态机不允许的转移 |
| `task_not_found` | 任务/DAG 不存在 |
| `knowledge_not_found` | 知识条目不存在或不可见 |
| `unsupported_file_type` | 导入文件类型不在 AnyDoc 白名单 |
| `conversion_failed` | AnyDoc 转换失败或超时 |
| `import_cancelled` | 导入任务已取消、不存在或状态不允许确认 |
| `permission_denied` | 用户无操作权限；（可选启发式）子代理输出/诊断文本命中非交互拒绝模式——非 DSH stopReason 枚举，见 2.4 |
| `execution_failed` | 子代理以 `error` / `max-tokens` / `refusal` 结束，或 `run.result` 因基础设施故障 reject（映射任务 FAILED，计熔断） |
| `timeout` | Weave 委托计时器超时（应用层判定；DSH stopReason 无 timeout 枚举，终止后通常表现为 `aborted`） |
| `configuration_error` | 插件配置、目录/数据库初始化错误 |
| `invalid_argument` | 外部接口（MCP/CLI/HTTP）参数缺失、类型错误或校验失败（LO-11：`SubmitTaskInput` 等入参校验统一使用） |
| `conflict` | 版本、角色、任务 ID 冲突 |

**层级关系（ME-8）**：本表为 Weave **对外错误码**（MCP/CLI/HTTP 响应与 `WeaveError.code`）；`tasks.error_type` 的持久化值域见 §2.4.3，两者交集（`execution_failed`/`timeout`/`executor_unavailable`/`permission_denied`）同名同义；DSH `stopReason` 值（`aborted`/`error`/`max-tokens`/`refusal`）只出现在 `tasks.error_type`，不对外暴露（对外以任务终态 CANCELLED/FAILED 表达）；`unavailable` 已归并为 `executor_unavailable`，`cancelled` 不作为错误码。

#### 1.1.3 鉴权与隔离

- 单机单进程部署，默认依赖 DSH 会话身份。
- MCP/CLI/HTTP 均从 DSH 会话上下文获得 `session_id`、`parentAgent`、`parent cwd`。
- 所有多团队选择遵循优先级链：**显式指定 > 会话绑定 > 默认团队 > 仅一个团队 > 提示选择**。

---

### 1.2 MCP Tools

| Tool | 阶段 | 功能 |
| --- | --- | --- |
| `weave_submit_task` | P0 | 提交任务，创建 DAG |
| `weave_get_status` | P0 | 查询任务/DAG 状态 |
| `weave_revise_task` | P0 | 保温期内发送修订反馈 |
| `weave_accept_task` | P0 | 确认任务完成并关闭 |
| `weave_team_list` | P0 | 列出可用团队 |
| `weave_team_switch` | P0 | 切换当前会话团队 |
| `weave_knowledge_search` | P1 | 检索知识 |
| `weave_knowledge_review` | P0 | 获取知识审核队列（HI-5：审核转正为 P0，含 approve/reject） |

#### 1.2.1 `weave_submit_task`

```typescript
type SubmitTaskInput = {
  description: string
  project_id: string
  version: string
  session_id?: string
  team_id?: string
  dependencies?: Array<{
    task_id: string
    artifacts?: string[]
  }>
}

type SubmitTaskOutput = {
  dag_id: string
  tasks: TaskRecord[]
  status: 'submitted'
}
```

- 入参校验（LO-11）：`description`/`project_id`/`version` 缺失或类型非法 → `invalid_argument`；`team_id` 不存在或团队校验失败 → `invalid_team`；数据库/配置初始化失败 → `configuration_error`。
- 同一 `(project_id, version)` 下任务 ID 连续且全局唯一。

#### 1.2.2 `weave_get_status`

```typescript
type GetStatusInput = {
  dag_id?: string
  task_id?: string
  project_id?: string
  version?: string
}

type GetStatusOutput = {
  dag_id?: string
  tasks: TaskRecord[]
}
```

- `task_id` 与 `dag_id` 至少提供一个。
- 未找到返回 `task_not_found`。

#### 1.2.3 `weave_revise_task`

```typescript
type ReviseTaskInput = {
  task_id: string
  feedback: string
}

type ReviseTaskOutput = {
  task_id: string
  status: TaskStatus
  revision_count: number
}
```

- 仅 `AWAITING_FEEDBACK` 状态可进入修订；其他状态返回 `invalid_status_transition`。
- 达到 `max_revisions` 后拒绝继续修订（返回 `invalid_status_transition`）。

#### 1.2.4 `weave_accept_task`

```typescript
type AcceptTaskInput = {
  task_id: string
}

type AcceptTaskOutput = {
  task_id: string
  status: 'CLOSED'
}
```

- 仅 `AWAITING_FEEDBACK` 可确认关闭：任务 `COMPLETED` 后由状态机自动进入 `AWAITING_FEEDBACK`（转移 #10，见 2.1.5）；对 `COMPLETED` 直接 accept 返回 `invalid_status_transition`。其它状态同。（LO-2）

#### 1.2.5 `weave_team_list`

```typescript
type TeamListInput = Record<string, never>

type TeamListOutput = {
  teams: Array<{
    team_id: string
    name: string
    default: boolean
    roles: string[]
  }>
}
```

#### 1.2.6 `weave_team_switch`

```typescript
type TeamSwitchInput = {
  team_id: string
  session_id?: string
}

type TeamSwitchOutput = {
  session_id: string
  team_id: string
}
```

- 会话绑定持久化到 `core.db.team_bindings`（DDL 见 2.6.8；写入经 `SingleWriterQueue`）；后续任务默认使用该团队（ME-4）。
- 重复切换至同一团队为 no-op；团队不存在或校验失败返回 `invalid_team`。
- 绑定表为 `selectTeam` 优先级链的第二级（显式指定 > **会话绑定** > 默认团队 > 仅一个团队 > 提示选择，见 1.5.1）。

#### 1.2.7 `weave_knowledge_search`

```typescript
type KnowledgeSearchInput = {
  query: string
  project_id?: string
  version?: string
  role_id?: string
  instance_id?: string
  visibility?: Visibility
  limit?: number              // 默认 5
  max_total_chars?: number    // 默认 2500
}

type KnowledgeSearchOutput = {
  entries: KnowledgeInjectionEntry[]
}
```

- P1 开放；P0 内部已有 `KnowledgeEngine.searchForInjection` 可作为最小实现。

#### 1.2.8 `weave_knowledge_review`（HI-5：P0）

```typescript
type KnowledgeReviewInput = {
  status?: KnowledgeStatus   // 默认 candidate
  layer?: KnowledgeLayer
  limit?: number
}

type KnowledgeReviewOutput = {
  candidates: KnowledgeMeta[]
}
```

- P1 开放；P0 后台可先经 Web 界面实现审核。

---

### 1.3 CLI 命令

| 命令 | 功能 | P0/P1 |
| --- | --- | --- |
| `/weave team list` | 列出团队 | P0 |
| `/weave team switch <team_id> [--session <session_id>]` | 切换团队 | P0 |
| `/weave task submit "<desc>" --project <pid> --version <ver> [--team <tid>] [--deps <task_ids>] [--json]` | 提交任务 | P0 |
| `/weave task status <task_id|dag_id>` | 查询状态 | P0 |
| `/weave task revise <task_id> "<feedback>"` | 保温期修订 | P0 |
| `/weave task accept <task_id>` | 确认完成 | P0 |
| `/weave task retry <task_id>` | 重试失败/中断任务 | P0 |
| `/weave task skip <task_id>` | 跳过任务 | P0 |
| `/weave task cancel <task_id>` | 取消任务 | P0 |
| `/weave task reopen <task_id>` | 24h 内重新打开已关闭任务 | P0 |
| `/weave dag <dag_id>` | 查看 DAG | P0 |
| `/weave knowledge search "<query>" [--project <pid>] [--version <ver>] [--role <rid>] [--json]` | 知识检索 | P1 |
| `/weave knowledge review` | 审核队列 | P0 |
| `/weave knowledge approve <knowledge_id>` | 知识转正（candidate → active） | P0 |
| `/weave knowledge reject <knowledge_id>` | 拒绝知识（candidate → deprecated） | P0 |
| `/weave executor list` | 执行器列表 | P0 |
| `/weave ban list` | 禁令列表 | P0 |

CLI 统一返回：

```typescript
type CliOutput<T> = {
  ok: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}
```

---

### 1.4 HTTP / Web API

基础前缀：`/weave`。DSH 提供 HTTP 路由、会话标识和静态资源托管。

| 方法 | 路径 | 功能 | 阶段 |
| --- | --- | --- | --- |
| `GET` | `/weave/overview` | 总览统计 | P0 |
| `GET` | `/weave/tasks` | 任务中心列表 | P0 |
| `POST` | `/weave/tasks` | 提交任务 | P0 |
| `GET` | `/weave/dag/{dag_id}/light` | 右侧面板轻量 DAG | P0 |
| `GET` | `/weave/knowledge` | 知识库列表 | P0 框架 / P1 完整 |
| `POST` | `/weave/knowledge/import` | 上传/创建导入任务 | P0 |
| `GET` | `/weave/knowledge/import/{job_id}` | 导入任务状态 | P0 |
| `POST` | `/weave/knowledge/import/{job_id}/preview` | 获取 Markdown 预览 | P0 |
| `POST` | `/weave/knowledge/import/{job_id}/confirm` | 确认并生成 candidate | P0 |
| `POST` | `/weave/knowledge/import/{job_id}/cancel` | 取消导入 | P0 |
| `GET` | `/weave/executors` | 执行器页 | P0 | 数据源（ME-7）：provider 列表 = `ctx.subagents.list()`；运行中进程数/每小时频率 = Weave 自计数（`ProcessLimiter.status()`），DSH API 无对应字段；来源 = provider 名 |
| `GET` | `/weave/sessions` | 会话管理 | P0 |
| `GET` | `/weave/audit` | 审计日志 | P0 |
| `GET` | `/weave/settings` | 设置 | P0 |

#### 1.4.1 提交任务

```http
POST /weave/tasks
Content-Type: application/json

{
  "description": "实现登录接口",
  "project_id": "demo",
  "version": "v1",
  "team_id": "alpha-squad",
  "dependencies": []
}
```

响应：

```json
{
  "ok": true,
  "data": {
    "dag_id": "demo-v1-000001",
    "tasks": []
  }
}
```

#### 1.4.2 知识导入上传

```http
POST /weave/knowledge/import
Content-Type: multipart/form-data

file=<binary>
meta={"target":"role","role_id":"designer","project_id":"demo","version":"v1","visibility":"role_only"}
```

响应：

```json
{
  "ok": true,
  "data": {
    "job_id": "imp_20260824_0001",
    "status": "uploaded",
    "file_type": "pdf",
    "original_filename": "design-guide.pdf"
  }
}
```

#### 1.4.3 导入状态与确认

- `GET /weave/knowledge/import/{job_id}` → `ImportJob`
- `POST /weave/knowledge/import/{job_id}/preview` → `{ markdown, warnings[] }`
- `POST /weave/knowledge/import/{job_id}/confirm` → `{ candidate: KnowledgeMeta }`
- `POST /weave/knowledge/import/{job_id}/cancel` → `{ ok: true }`

---

### 1.5 内部服务接口

#### 1.5.1 TeamManager

```typescript
class TeamManager {
  async loadTeam(teamId: string): Promise<TeamConfig>
  async listTeams(): Promise<TeamConfig[]>
  /** 返回 null = 需要用户显式选择（多团队且无绑定/无默认）；调用方提示后由 team_switch 绑定（ME-4） */
  async selectTeam(sessionId: string, explicit?: string): Promise<TeamConfig | null>
  async validateTeam(team: TeamConfig, executorRegistry: ExecutorRegistry): Promise<void>
}
```

- `selectTeam` 优先级链：`explicit`（显式指定）> `team_bindings`（会话绑定，ME-4）> 团队 `default: true` > 仅一个团队（自动）> 提示选择（返回 `null`，不抛错）。
- 会话绑定在 `team_switch`（1.2.6）时 UPSERT 到 `team_bindings`（2.6.8）。
- `validateTeam` 会检查每个 `role.executor` 是否已在 `ExecutorRegistry` 注册；并校验阶段→角色绑定规则（2.3.2：每角色 `stages` 非空、每模板阶段至少绑定一个角色、`dag_templates[default_difficulty]` 存在）。
- 非法团队直接加载失败，不进入任务调度。

#### 1.5.2 Orchestrator

```typescript
class Orchestrator {
  async submitTask(input: SubmitTaskInput): Promise<TaskDag>
  async getDag(dagId: string): Promise<TaskDag>
  async runReadyTasks(team: TeamConfig): Promise<void>
  async propagateFailure(taskId: string): Promise<void>
  async reactivateSkipped(taskId: string): Promise<void>
}

- `submitTask`：匹配难度（未命中 matcher 用 `default_difficulty` 兜底，2.3.2）→ 按 `dag_templates` 生成任务（每任务记录 `dag_id`/`stage`）→ 绑定角色（阶段→角色规则 2.3.2）→ 同事务写 `dags`/`tasks`/`edges`（2.6.6/2.6.7）与 `task_sequences` 取号；
- `getDag`：`dags` + `edges` + `tasks`（按 `dag_id`）联合读取，无进程内状态（HI-3）；
- `runReadyTasks`：`WAITING` 且依赖满足的任务按 `task.stage → role.stages` 绑定角色；角色级在途任务数 ≥ `role.max_concurrent_tasks` 时不派发（软限制，ME-3），执行器级由 `ProcessLimiter`（`executor_limits`）硬限制；
- 所有状态转移经 `TaskStateMachine`（权威矩阵 2.1.5），非法转移抛 `invalid_status_transition`。
```

#### 1.5.3 DelegationService

```typescript
class DelegationService {
  constructor(
    private ctx: Context,
    private executorRegistry: ExecutorRegistry,
    private sessionTracker: SessionTracker,
    private processLimiter: ProcessLimiter,
    private knowledgeEngine: KnowledgeEngine,
  ) {}

  async executeTask(
    task: TaskRecord,
    role: RoleConfig,
    team: TeamConfig,
    context: TaskContext,
    cancelSignal: AbortSignal,
  ): Promise<SubagentTaskOutput>
}
```

- 必须通过 `ctx.subagents.start(role.executor, { prompt: ContentBlock[], parent, signal })` 调用执行器（第 2 轮修订：`prompt` 为 `ContentBlock[]`，`parent: Agent`、`signal: AbortSignal` 必填）。
- 不自行 spawn/kill 进程；`start()` 返回 `SubagentRun`，`await run.result` 得到 `SubagentResult`（子代理失败时 resolve，不 reject）。
- 执行前申请 `ProcessLimiter` 槽位，`finally` 中释放。
- `mapResult(run, result, durationMs)`：`SubagentRun`+`SubagentResult` → `SubagentTaskOutput`（见 2.4），`duration_ms` 由 Weave 自计时。
- 知识注入限额取 `team.knowledge_injection`（团队级唯一来源；P0 无角色级覆盖——ME-2）。

#### 1.5.4 ExecutorRegistry

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
  capabilities: SubagentCapabilities   // outputSchema / depthLimit / toolFilter / persona
}

class ExecutorRegistry {
  load(ctx: Context): void           // ctx.subagents.list() 为同步方法
  get(id: string): ExecutorInfo | undefined
  list(): ExecutorInfo[]
  kindOf(id: string): ExecutorKind | undefined
}
```

- `capabilities` 数据源：`ctx.subagents.getProvider(name).capabilities`（provider 注册时声明；缺失时默认全 false）；
- 第 2 轮修订：删除原 `supports_feedback_loop / non_interactive / ephemeral_session` 字段（DSH API 无数据源、原实现为全同常量）；P0 无消费方，仅作展示/预留。

分类规则：

| provider 值 | kind |
| --- | --- |
| `spawn` / `fork` / 自定义 DSH provider | `dsh_subagent` |
| `codex` | `codex` |
| `claude-code` | `claude_code` |
| 其它通过 ACP 注册的工具 | `acp` |

#### 1.5.5 SessionTracker

```typescript
interface RevisionRecord {
  task_id: string
  revision_count: number
  previous_result: string | null
  user_feedback: string[]
  updated_at: string
}

class SessionTracker {
  async recordRevision(taskId: string, feedback: string, previousResult: string | null): Promise<void>
  async getRevisionContext(taskId: string): Promise<string | null>
  async clearRevision(taskId: string): Promise<void>
}
```

#### 1.5.6 FeedbackRouter

```typescript
class FeedbackRouter {
  async route(taskId: string, rawFeedback: string): Promise<{
    intent: 'accept' | 'revise' | 'cancel'
    task: TaskRecord
  }>
}
```

意图识别规则：

| 正则 | intent |
| --- | --- |
| `^(可以|确认|就这样|没问题|OK|ok)\b` | `accept` |
| `^(不对|改成|修改|重新|换)\b` | `revise` |
| `^(取消|算了|不做了)\b` | `cancel` |

#### 1.5.7 KnowledgeEngine

```typescript
class KnowledgeEngine {
  async searchForInjection(params: InjectionSearchParams): Promise<KnowledgeInjectionEntry[]>
  async reviewQueue(filter?: KnowledgeReviewFilter): Promise<KnowledgeMeta[]>
  async approve(knowledgeId: string): Promise<KnowledgeMeta>
  async reject(knowledgeId: string, reason: string): Promise<void>
}
```

#### 1.5.8 ImportPipeline

```typescript
interface ImportPipeline {
  upload(file: UploadedFile, meta: ImportMeta): Promise<ImportJob>
  convert(jobId: string): Promise<ConvertResult>
  preview(jobId: string): Promise<{ markdown: string; warnings: string[] }>  // LO-5：与 HTTP /preview（1.4.3）一致
  confirm(jobId: string, edited: KnowledgeCandidate): Promise<string>
  cancel(jobId: string): Promise<void>
}
```

#### 1.5.9 CircuitBreaker / ProcessLimiter / SingleWriterQueue

```typescript
class CircuitBreaker {
  async check(scope: string, entityKey: string): Promise<void>   // 失败抛 WeaveError
  async recordFailure(scope: string, entityKey: string): Promise<void>
  async recordSuccess(scope: string, entityKey: string): Promise<void>
  async resolve(entityKey: string): Promise<void>
}

class ProcessLimiter {
  acquire(executorId: string): boolean
  release(executorId: string): void
  async waitForProcessSlot(executorId: string, signal: AbortSignal): Promise<void>
}

class SingleWriterQueue {
  run<T>(write: () => Promise<T>): Promise<T>
}

- `ProcessLimiter` 配置源 = `team.yaml.executor_limits`（键 = `role.executor` 的 provider 名；schema 见 2.3.3；缺省 `{ max_concurrent: 1, max_per_hour: 20 }`；ME-6）；超限排队等待，不触发熔断。
- 分层限流（ME-3）：`role.max_concurrent_tasks` 为**调度软限制**（`runReadyTasks` 在角色在途任务数 ≥ 上限时不派发）；`executor_limits` 为**执行器硬限制**（决定能否启动）。两者独立：样例中 designer/reviewer 共用 `codex` 时共享执行器级配额，角色级各自计数。
```

#### 1.5.10 ReflectionEngine（P1）

```typescript
class ReflectionEngine {
  async reflect(task: TaskRecord, output: SubagentTaskOutput, baseline: BaselineStats): Promise<KnowledgeCandidate | null>
}
```

---

## 2 数据模型规格

### 2.1 任务模型

#### 2.1.1 状态枚举

```typescript
type TaskStatus =
  | 'WAITING'
  | 'BLOCKED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'AWAITING_FEEDBACK'
  | 'REVISION_RUNNING'
  | 'CLOSED'
  | 'FAILED'
  | 'BANNED'
  | 'LOOP_TERMINATED'
  | 'INTERRUPTED'
  | 'CANCELLED'
  | 'SKIPPED'
  | 'COOLDOWN'
```

> 说明（第 3 轮修订）：14 态枚举与权威转移矩阵见 §2.1.5。`COOLDOWN` 纳入任务状态机：唯一进入路径 `BANNED → COOLDOWN`，离开路径 `COOLDOWN → WAITING`（或人工 `COOLDOWN → SKIPPED`）；不再允许“合并入 BANNED 字段”的变通实现。

#### 2.1.2 任务记录

```typescript
interface TaskRecord {
  id: string
  dag_id: string                    // 所属 DAG（HI-3；与 dags.dag_id 一致）
  session_id: string
  team_id: string
  project_id: string
  version: string
  description: string
  stage: string                    // DAG 模板阶段名（design/implement/...，HI-4）
  dependencies: string[]          // JSON 序列化存储
  assigned_agent: string | null
  executor: string | null
  status: TaskStatus
  revision_count: number
  max_revisions: number
  feedback_timeout_seconds: number
  feedback_expires_at: string | null
  skip_override: boolean
  skip_reason: string | null
  fail_count: number
  result: string | null
  error_type: string | null   // DSH stopReason 或 Weave 应用层错误码（见 2.4.3）
  created_at: string
  updated_at: string
}
```

#### 2.1.3 DAG 与提交输入

```typescript
interface TaskDag {
  dag_id: string
  tasks: TaskRecord[]
  edges: Array<{ from: string; to: string }>
  status: 'created' | 'running' | 'completed' | 'failed'
}
```

`SubmitTaskInput` 见 1.2.1。

**DAG 持久化（HI-3）**：`dag_id` 关联 `dags` 表（2.6.6）；任务依赖以 `edges` 表（2.6.7，`dag_id` + `from_task_id` + `to_task_id`）存储；`TaskDag.edges` 与 `tasks.dependencies` 保持同构（提交时由模板/依赖输入推导，两处一致）；`getDag` 由三表联合读取。

#### 2.1.4 任务表 DDL

```sql
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    dag_id TEXT NOT NULL,        -- 所属 DAG（HI-3；与 dags.dag_id 一致）
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
    error_type TEXT,             -- DSH stopReason 或 Weave 应用层错误码（见 2.4.3）
    created_at TEXT,
    updated_at TEXT
);

#### 2.1.5 状态转移矩阵（权威，第三轮修订）

> 本文为 14 态 × 32 条转移的唯一权威来源；FDD §4.4.2 / SDD §2.2.3 / 架构 §4.2.2 的表述与本表一致，以本表为准。
> `COOLDOWN` 处置：纳入任务状态机（第 14 态），唯一路径 `BANNED → COOLDOWN → WAITING`（或人工 `COOLDOWN → SKIPPED`）；不再允许“合并入 BANNED 字段”的变通实现。

| # | 当前状态 | 目标状态 | 触发 | 前置条件 | 副作用 / 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | WAITING | BLOCKED | 依赖检查：上游未全部到达成功终态（COMPLETED / CLOSED） | 任务已在 DAG 内 | 上游完成或失败时由传播/重估规则（2.2.4）重估 |
| 2 | BLOCKED | WAITING | 依赖全部满足（上游成功终态，或上游被 override） | 无 | 进入就绪队列 |
| 3 | WAITING | RUNNING | `runReadyTasks` 派发：角色软限制通过 + 执行器槽位可获取 | 角色已绑定（见 2.3.2） | 记录运行开始时间 |
| 4 | RUNNING | COMPLETED | 子代理 `stopReason=completed` | — | 写入 `result`；随后自动进入 AWAITING_FEEDBACK（#10） |
| 5 | RUNNING | FAILED | 按 §2.4.3 映射（`error`/`max-tokens`/`refusal`/基础设施 reject/应用层 `timeout`/可选 `permission_denied`） | — | 写入 `error_type`；计入断路器失败计数 |
| 6 | RUNNING | BANNED | 断路器触发（连续失败 ≥ 3） | — | 计熔断；后续走 #20 / #21 |
| 7 | RUNNING | LOOP_TERMINATED | 循环检测命中（步数 / 工具重复 / 输出零增长 / 时间限制） | — | 计熔断（循环防护） |
| 8 | RUNNING | INTERRUPTED | 外部中断（暂停 / 信号，非用户取消） | — | 可恢复：retry 走 #26 或取消 |
| 9 | RUNNING | CANCELLED | 用户取消 | — | 不计熔断；`stopReason=aborted` |
| 10 | COMPLETED | AWAITING_FEEDBACK | 自动：完成任务进入保温期 | 任务完成 | `feedback_expires_at = now + feedback_timeout_seconds`（默认 1800s） |
| 11 | AWAITING_FEEDBACK | REVISION_RUNNING | 用户 revise（意图识别命中） | `revision_count < max_revisions` | `revision_count + 1`；`SessionTracker.recordRevision`；保温期重置 |
| 12 | AWAITING_FEEDBACK | CLOSED | accept 或保温期超时 | — | `SessionTracker.clearRevision`；写 `feedback_routes.closed_at` |
| 13 | AWAITING_FEEDBACK | CANCELLED | 用户 cancel | — | 终态，参与失败传播 |
| 14 | REVISION_RUNNING | COMPLETED | 修订委托完成（`stopReason=completed`） | — | 写 `result`；保温期重置（回到 #10 的入口） |
| 15 | REVISION_RUNNING | FAILED | 修订执行失败 / 超时（按 §2.4.3） | — | **ME-5**：`feedback_routes.previous_result` 保留上一版输出；`revision_count` 不回退；可 retry（#18）继续修订上下文 |
| 16 | REVISION_RUNNING | CANCELLED | 修订取消（用户取消 / cancelSignal） | — | ME-5：不计熔断；上下文保留同 #15 |
| 17 | CLOSED | AWAITING_FEEDBACK | reopen（`reopen_window_seconds`=86400s 内） | reopened 次数允许 | 保温期重置；`reopen_count + 1` |
| 18 | FAILED | WAITING | retry | 断路器未禁用该实体 | 失败计数保留（断路器侧）；任务重新排队 |
| 19 | FAILED | SKIPPED | skip（人工跳过） | — | `skip_override = 1` |
| 20 | BANNED | COOLDOWN | 冷却开始（BAN expiry 或手动解除） | — | 记录 `cooldown_seconds` |
| 21 | BANNED | SKIPPED | skip（熔断下人工跳过） | — | `skip_override = 1` |
| 22 | COOLDOWN | WAITING | 冷却结束 | — | 任务可再次派发 |
| 23 | COOLDOWN | SKIPPED | 冷却期间人工 skip | — | `skip_override = 1` |
| 24 | LOOP_TERMINATED | WAITING | retry | — | — |
| 25 | LOOP_TERMINATED | SKIPPED | skip | — | — |
| 26 | INTERRUPTED | WAITING | retry | — | — |
| 27 | INTERRUPTED | SKIPPED | skip | — | — |
| 28 | INTERRUPTED | CANCELLED | cancel | — | 终态 |
| 29 | CANCELLED | WAITING | retry（用户显式恢复） | — | 终态恢复 |
| 30 | CANCELLED | SKIPPED | skip | — | — |
| 31 | WAITING | CANCELLED | cancel（等待中取消） | — | — |
| 32 | BLOCKED | CANCELLED | cancel（阻塞中取消） | — | — |

**矩阵说明**

- **失败终态**：`FAILED / BANNED / LOOP_TERMINATED / CANCELLED` → 触发下游 `WAITING/BLOCKED → SKIPPED` 传播（规则见 SDD §2.2.4；传播为派生规则，不计入上表 32 条）。
- **成功终态**：`COMPLETED / CLOSED`；`AWAITING_FEEDBACK` 为中间态，`CLOSED` 可经 #17 重开。
- **吸收态**：`SKIPPED` 无出边；上游 retry/skip 后由 `reactivateSkipped` 恢复 `WAITING/BLOCKED`（非 SKIPPED 出边，迭代保护 100 次）。
- **修订失败（ME-5）**：#15/#16 之后任务可经 #18/#19 继续；修订上下文（`previous_result`、`user_feedback`、`revision_count`）保留至 accept（#12 → `clearRevision`）。
- **COOLDOWN 驱动**：#20/#22/#23 使 `COOLDOWN` 同时具备进出转移；实现必须提供 #20 → #22 的定时驱动（冷却结束事件）。

---

### 2.2 知识模型

#### 2.2.1 类型与状态

```typescript
type KnowledgeType = 'doc' | 'skill' | 'guide' | 'pitfall' | 'pattern' | 'other'
type KnowledgeStatus = 'candidate' | 'active' | 'deprecated' | 'superseded'
type KnowledgeLayer = 'project' | 'role' | 'instance' | 'shared'

type Visibility =
  | 'project_only'
  | 'role_only'
  | 'instance_only'
  | 'global'
```

#### 2.2.2 Frontmatter

```yaml
schema_version: "1"
title: gRPC 级联超时踩坑记录
type: pitfall
status: candidate
confidence: 0.1
created: 2026-08-24
freshness_score: 1.0
visibility: project_only
tags: [gRPC, 超时]
```

必须字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schema_version` | string | 固定 `"1"` |
| `title` | string | 知识标题 |
| `type` | string | `KnowledgeType` |
| `status` | string | `KnowledgeStatus` |
| `confidence` | number | `[0,1]`，初始 `0.1` |
| `created` | date | ISO 8601 日期（`YYYY-MM-DD`，ISO 8601 日期子集；LO-4 与 §0.3 基线统一：知识 frontmatter 用日期粒度，其余时间字段用完整时间戳） |
| `freshness_score` | number | `[0,1]`，初始 `1.0` |
| `visibility` | string | `Visibility` |
| `tags` | string[] | 检索标签 |

#### 2.2.3 知识元数据

```typescript
interface KnowledgeMeta {
  id: string
  path: string
  layer: KnowledgeLayer
  status: KnowledgeStatus
  confidence: number
  freshness_score: number
  last_confirmed: string | null
  model_version: string | null
  created: string
  updated: string
  superseded_by?: string
}
```

#### 2.2.4 注入条目

```typescript
interface KnowledgeInjectionEntry {
  id: string
  title: string
  content: string
  layer: KnowledgeLayer
  visibility: Visibility
  freshness_score: number
}
```

#### 2.2.5 生命周期与置信度

```text
candidate → active → deprecated | superseded
```

- 初始 `confidence = 0.1`
- 成功复现 `+0.15`
- 复现失败 `-0.15`
- 阈值 `0.75`
- `clip(0, 1)`

#### 2.2.6 知识检索权重

| 来源 | 权重 |
| --- | --- |
| 当前版本项目知识 | `1.0 × freshness` |
| 跨版本共享项目知识 | `0.9 × freshness` |
| 实例知识 | `0.85 × freshness` |
| 角色知识（同项目） | `0.8 × freshness` |
| 全局知识 | `0.6 × freshness` |
| 角色知识（跨项目） | `0.4 × freshness` |
| 其他版本项目知识 | `0.3 × freshness`（默认不参与） |

---

### 2.3 角色与团队模型

```typescript
interface RoleConfig {
  id: string
  name: string
  bias: string
  executor: string
  /** P0 必填非空：该角色可执行的 DAG 阶段名集合（HI-4，阶段→角色绑定依据） */
  stages: string[]
  max_concurrent_tasks: number
  personality: string
  /** 可选 LLM provider 覆盖；缺省继承父会话路由。 */
  provider?: string
  /** 可选模型 id 覆盖；缺省继承父会话模型。 */
  model?: string
}

interface ExecutorLimit {
  max_concurrent: number
  max_per_hour: number
}

interface TaskDecomposition {
  matchers: Array<{
    pattern: string
    difficulty: 'easy' | 'medium' | 'hard' | 'critical'
  }>
  /** matcher 未命中时的兜底难度（HI-4），缺省 'hard' */
  default_difficulty?: 'easy' | 'medium' | 'hard' | 'critical'
  dag_templates: Record<string, string[]>
}

interface KnowledgeInjection {
  max_entries: number
  max_chars_per_entry: number
  max_total_chars: number
  priority: 'freshness_first'
}

interface FeedbackConfig {
  feedback_timeout_seconds: number
  max_revisions: number
  reopen_window_seconds: number
}

interface TeamConfig {
  team_id: string
  name: string
  default: boolean
  roles: RoleConfig[]
  task_decomposition: TaskDecomposition
  knowledge_injection: KnowledgeInjection
  feedback: FeedbackConfig
  /** 执行器级限流（ME-6）；键 = role.executor（provider 名）；缺省 { max_concurrent: 1, max_per_hour: 20 } */
  executor_limits?: Record<string, ExecutorLimit>
}
```

`team.yaml` 文件路径：`~/.dsh/teams/{team_id}.yaml`，`schema_version: "1"`。

**阶段 → 角色绑定规则（HI-4）**

- 阶段名集合来自 `dag_templates`（内建：`prepare`/`design`/`implement`/`review`/`test`/`integrate`/`deploy`/`execute`；模板可扩展，但扩展阶段必须被至少一个角色声明）；
- 绑定：对模板中每个阶段 `s`，按 `roles` 声明顺序取第一个 `s ∈ role.stages` 的角色；绑定结果写入 `tasks.assigned_agent`（存**角色 id**，执行器 id 经 `role.executor` 解析——LO-9 术语澄清）与 `tasks.stage`；
- 兜底：无任何角色声明 `s` 时，尝试“阶段名 = 角色 id”隐式匹配；仍无 → DAG 构建失败，返回 `configuration_error`（不允许静默跳过任务，避免 DAG 不完整）；
- 校验（`TeamManager.validateTeam`）：每角色 `stages` 非空；每个模板用到的阶段名至少绑定一个角色；角色 `stages` 中未在模板中使用的阶段名允许（扩展储备）。

**matcher 兜底难度（HI-4）**

- 命中规则：文本命中任一 `pattern` → 取该难度；多命中 → 取最高（critical > hard > medium > easy）；
- 未命中 → `default_difficulty`（缺省 `'hard'`），并校验 `dag_templates[default_difficulty]` 存在；
- `pattern` 必须为合法正则；非法配置 → `configuration_error`，团队禁用。

**限流配置（ME-3 / ME-6）**

- `executor_limits`（键 = `role.executor` 的 provider 名）：`max_concurrent`（并发硬限制）与 `max_per_hour`（小时频率硬限制），缺省 `{ max_concurrent: 1, max_per_hour: 20 }`；`ProcessLimiter` 以它为唯一配置来源（非 P0 自定义 CLI 执行器同样适用，`executors.yaml` 同名键可覆盖）；
- 角色级 `max_concurrent_tasks` = 调度软限制：`runReadyTasks` 统计该角色在途（RUNNING/REVISION_RUNNING）任务数，达到上限不派发；软限制与执行器级硬限制独立叠加；样例中 designer/reviewer 共用 `codex` 时共享执行器级配额，但角色级各自独立计数。

---

### 2.4 执行器模型（第 2 轮修订）

见 1.5.4 `ExecutorKind` / `ExecutorInfo`。对外契约以真实 DSH 0.1.1-rc.2 为准（来源：`@deepseek-ai/dsh-subagent/lib/types/types.d.ts`、`lib/types/index.d.ts`）。

#### 2.4.1 DSH 真实 API 契约（只读引用，不重复定义）

```typescript
import type {
  SubagentStartRequest,
  SubagentRun,
  SubagentResult,
  SubagentStopReason,
  SubagentCapabilities,
} from '@deepseek-ai/dsh-subagent'

// SubagentStartRequest（pick Weave 使用的字段）：
// { prompt: ContentBlock[]; parent: Agent; signal: AbortSignal;
//   label?; agentOptions?; outputSchema?; maxDepth?; toolFilter?; persona? }
//   - prompt 为 ContentBlock[]（非 string）；parent / signal 必填
// ctx.subagents.start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
// SubagentRun: { id; localAgent?: Agent; result: Promise<SubagentResult>; dispose(): Promise<void> }
// SubagentResult: { output: ContentBlock[]; structured?: unknown; diagnostic?: string; stopReason: SubagentStopReason }
// SubagentStopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'   （merge-extensible）
// SubagentCapabilities: { outputSchema: boolean; depthLimit: boolean; toolFilter: boolean; persona: boolean }
// ctx.subagents.list(): string[]                                —— 同步方法
// ctx.subagents.getProvider(name): SubagentProvider | undefined —— capabilities 数据源
```

- `run.result` 在子代理失败时 **resolve**（`stopReason='error'`），不 reject；仅基础设施故障 reject；
- 取消：`signal` 直达 DSH（终止为 `aborted`）；主动放弃已发布运行调用 `run.dispose()`（幂等）。

#### 2.4.2 Weave 内部结果类型 `SubagentTaskOutput`

```typescript
type SubagentTaskOutput = {
  id: string                   // run.id
  output: ContentBlock[]       // result.output（子代理最终 assistant 内容；空时 []）
  structured?: unknown         // result.structured（仅当请求 outputSchema 且成功）
  diagnostic?: string          // result.diagnostic（失败细节，≤4096B）
  stopReason: SubagentStopReason
  duration_ms: number          // Weave 自计时（start() → result 完成）；DSH API 不提供
}
```

> 第 2 轮修订：删除原 `success / stdout / stderr / summary / error_type` 字段——DSH API 无 `stdout/stderr/summary`，`error_type` 不再内嵌于输出，改由映射表（2.4.3）与 `tasks.error_type` 承载。

#### 2.4.3 错误映射（stopReason → 任务终态 + 诊断规则）

| 来源 | 值 | `tasks.error_type` | 任务终态 | 计入熔断 | 诊断规则 |
| --- | --- | --- | --- | --- | --- |
| DSH `stopReason` | `completed` | —（null） | `COMPLETED` | 否 | 正常完成；非交互拒绝可能以此出现（见 5.4） |
| DSH `stopReason` | `aborted` | `aborted` | `CANCELLED` | 否 | cancelSignal / dispose / 用户取消 |
| DSH `stopReason` | `error` | `execution_failed` | `FAILED` | 是 | 模型/传输失败（resolve 而非 reject） |
| DSH `stopReason` | `max-tokens` | `execution_failed` | `FAILED` | 是 | token 上限 |
| DSH `stopReason` | `refusal` | `execution_failed` | `FAILED` | 是 | 拒绝任务 |
| DSH 基础设施 reject | — | `execution_failed` | `FAILED` | 是 | `start()` 拒绝 / `run.result` reject |
| Weave 应用层 | 计时器到期 | `timeout` | `FAILED` | 是 | 终止运行（signal/dispose）；stopReason 通常为 `aborted`，终态以 Weave 判定为准 |
| Weave 应用层（可选启发式） | 输出/诊断文本命中拒绝模式 | `permission_denied` | `FAILED` | 是 | 匹配"需要批准/需要授权/approval required/permission denied"等；未命中按 stopReason 映射 |
| Weave 应用层 | 注册表校验失败 / provider 不存在 | `executor_unavailable` | 委托前拦截 | 否 | 不进入执行 |

> 原映射（`timeout/execution_failed/permission_denied/cancelled/parse_failed/crash/unavailable` 作为 DSH 返回现象）已废止：上述枚举中只有 `completed/aborted/error/max-tokens/refusal` 存在于 DSH API；`cancelled` 由 `aborted` 承载；`parse_failed`、`crash` 不再单列（输出为 `ContentBlock[]` 无需解析为 stdout；崩溃表现为 `error` 或基础设施 reject）。

**与 §1.1.2 的层级关系（ME-8）**：上表值域是 `tasks.error_type` 的持久化值域（DSH stopReason 或 Weave 应用层类别）；§1.1.2 是 Weave 对外错误码（接口响应/`WeaveError.code`）。交集项（`execution_failed`/`timeout`/`executor_unavailable`/`permission_denied`）同名同义；`aborted`/`error`/`max-tokens`/`refusal` 仅存于本表（对外以任务终态表达）；`unavailable` 已归并为 `executor_unavailable`；`cancelled` 不再作为错误码。

---

### 2.4.4 执行器模型路由与实时事件

`RoleConfig` 支持可选运行时覆盖：`provider`、`model`、`thought_level`、`mode`。委托时转换为 DSH 官方字段并传入唯一执行出口：

```typescript
ctx.subagents.start(role.executor, {
  prompt,
  parent,
  signal,
  agentOptions: {
    provider: role.provider,
    model: role.model,
  },
})
```

约束：

- 三个字段均可选；全部缺省时不得发送空 `agentOptions`；
- `provider` / `model` 缺省时继承父会话路由；
- 该路由由 DSH `resolveChildAgentOptions` 消费，对 DSH in-process 执行器（如 `spawn` / `fork`）生效；
- 外部 CLI 执行器是否消费模型取决于其 provider 实现；stock Codex / Claude Code provider 当前不读取该字段。

`DelegationService` 通过 `ExecutorProviderRegistry` 抽象具体执行器。Provider 必须声明 capabilities（实时输出、会话复用、模型选择、思考深度、模式、工具管理），Registry 按 executor id / supports() 解析。ZCode ACP Provider 是参考实现；DSH 原生子代理由 fallback Provider 包装。

`DelegationService` 支持可选 `onExecutorEvent`，并保留按 `runId` 查询的事件环形缓冲。事件类型为 `status | output | reasoning | tool_call | tool_result`。有 `run.localAgent` 时订阅其 scoped context 的 `session/event`；`assistant/chunk(text-delta)` 映射为 `output`，reasoning delta 映射为 `reasoning`；无 `localAgent` 的执行器发 `status:text=stream_unavailable`。观察者异常不得影响委托主链路。
---
---

### 2.5 导入记录模型

#### 2.5.1 导入任务

```typescript
type ImportStatus =
  | 'uploaded'
  | 'converting'
  | 'converted'
  | 'previewing'
  | 'reviewing'
  | 'confirmed'
  | 'active'
  | 'cancelled'
  | 'failed'

interface ImportMeta {
  target: 'project' | 'role' | 'instance' | 'global'
  project_id?: string
  version?: string
  role_id?: string
  instance_id?: string
  visibility: Visibility
  created_by?: string
}

interface ImportJob {
  id: string
  original_filename: string
  file_type: string
  file_path: string
  status: ImportStatus
  anydoc_job_id: string | null
  markdown_path: string | null
  converted_title: string | null
  converted_body: string | null
  target_project_id: string | null
  target_version: string | null
  target_role_id: string | null
  target_instance_id: string | null
  visibility: Visibility
  candidate_id: string | null
  error_message: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

interface ConvertResult {
  job_id: string
  status: ImportStatus
  markdown: string
  title: string
  warnings: string[]
  output_path: string
}

interface KnowledgeCandidate {
  title: string
  content: string
  type: KnowledgeType
  visibility: Visibility
  tags: string[]
  target_project_id?: string
  target_version?: string
  target_role_id?: string
  target_instance_id?: string
}
```

#### 2.5.2 导入表 DDL（TDD 细化）

> 架构文档未给出导入表 SQL；本规格为 TDD 细化。建议存于 `state/imports.db`，或与 `knowledge_meta.db` 同库。

```sql
CREATE TABLE IF NOT EXISTS import_jobs (
    id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploaded',
    anydoc_job_id TEXT,
    markdown_path TEXT,
    converted_title TEXT,
    converted_body TEXT,
    target_project_id TEXT,
    target_version TEXT,
    target_role_id TEXT,
    target_instance_id TEXT,
    visibility TEXT NOT NULL,
    candidate_id TEXT,
    error_message TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

### 2.6 其他核心表 DDL

#### 2.6.1 `feedback_routes`

```sql
CREATE TABLE IF NOT EXISTS feedback_routes (
    task_id TEXT PRIMARY KEY,
    executor_id TEXT NOT NULL,
    revision_count INTEGER DEFAULT 0,
    status TEXT,
    last_completed_at TEXT,
    closed_at TEXT,
    reopen_count INTEGER DEFAULT 0,
    user_feedback TEXT DEFAULT '[]',
    previous_result TEXT
);
```

#### 2.6.2 `knowledge_meta`

```sql
CREATE TABLE IF NOT EXISTS knowledge_meta (
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
```

#### 2.6.3 `task_sequences`

```sql
CREATE TABLE IF NOT EXISTS task_sequences (
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    next_n INTEGER DEFAULT 1,
    PRIMARY KEY (project_id, version)
);
```

#### 2.6.4 `bans`

```sql
CREATE TABLE IF NOT EXISTS bans (
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
```

#### 2.6.5 `failure_counters`

```sql
CREATE TABLE IF NOT EXISTS failure_counters (
    entity_key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    updated_at TEXT
);

#### 2.6.6 `dags`

```sql
CREATE TABLE IF NOT EXISTS dags (
    dag_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    difficulty TEXT NOT NULL,                    -- easy/medium/hard/critical
    status TEXT NOT NULL DEFAULT 'created',      -- created/running/completed/failed
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

#### 2.6.7 `edges`

```sql
CREATE TABLE IF NOT EXISTS edges (
    dag_id TEXT NOT NULL,
    from_task_id TEXT NOT NULL,
    to_task_id TEXT NOT NULL,
    PRIMARY KEY (dag_id, from_task_id, to_task_id)
);
```

#### 2.6.8 `team_bindings`

```sql
CREATE TABLE IF NOT EXISTS team_bindings (
    session_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

### 2.7 文件目录模型

```text
~/.dsh/
├── executors.yaml                # 非 P0 自定义 CLI 执行器（后备）
├── teams/
│   └── {team_id}.yaml
├── knowledge/
│   ├── _agent/
│   │   ├── projects/{project_id}/{version}/
│   │   ├── roles/{role_id}/
│   │   ├── instances/{instance_id}/
│   │   └── shared/
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
└── graphify-out/                # P1：Graphify 产物目录；P0 不创建（ME-10）
```

---

## 3 AnyDoc / Graphify / Obsidian 转换契约

### 3.1 AnyDoc 转换契约（P0）

#### 3.1.1 定位

AnyDoc 是知识导入源/转换器，**不是执行器**。不通过 `ctx.subagents.start` 调用，不进入执行器限流，不受执行器熔断影响。

#### 3.1.2 支持类型白名单

```text
DOC(`.doc`) / DOCX(`.docx`) / PDF(`.pdf`) / PPT(`.ppt`, `.pptx`) / Excel(`.xls`, `.xlsx`) / EPUB(`.epub`) / CSV(`.csv`) / RTF(`.rtf`) / ODT(`.odt`)  // LO-6：显式扩展名
```

后续扩展类型通过 AnyDoc 转换器扩展，不改业务入口。

#### 3.1.3 输入输出

| 项 | 约定 |
| --- | --- |
| 输入 | 用户上传文件 + `ImportMeta`（目标归属/可见性） |
| 输出 | GitHub-Flavored Markdown（GFM） |
| 图片/资源 | 按 AnyDoc 能力转为引用路径或附件；P0 不保证复杂版式还原 |
| 编码 | UTF-8 |
| 大小限制 | 由 DSH/部署配置决定；单文件超过限制返回可读错误 |
| 安全 | 导入时不执行文件内宏/脚本，仅做文档解析 |

#### 3.1.4 管线协议

> LO-10 语义说明：`previewing` = 用户查看 AnyDoc 转换结果（只读预览，可决定 cancel）；`reviewing` = 用户确认归属/编辑内容后等待确认（进入该态后 `confirm` 生成 candidate 并进入审核队列）。两态均不写 active。

```text
uploaded
  → converting
  → converted
  → previewing
  → reviewing        # 用户确认归属/编辑后生成 candidate
  → confirmed
  → active           # P0 审核队列 approve 后转正（HI-5）
```

状态机允许：

- `uploaded → converting`
- `converting → converted | failed`
- `converted → previewing | failed`
- `previewing → reviewing | cancel`
- `reviewing → confirmed | cancel | failed`
- `confirmed → active`（P0：审核队列 approve；reject → `candidate` 置 `deprecated`，HI-5）
- 任意非终态 → `cancelled`

#### 3.1.5 `ImportPipeline` 接口约束

1. `upload` 必须返回 `ImportJob`，且初始 `status='uploaded'`。
2. `convert` 失败时写入 `error_message`，状态置 `failed`，不污染 `knowledge/_agent`。
3. `preview` 必须返回 `{ markdown, warnings[] }`（LO-5：与 HTTP `/preview` 一致），markdown 为用户可读 GFM；可在服务端生成临时预览，但未确认前不写 active。
4. `confirm` 接收用户可能编辑后的 `KnowledgeCandidate`，生成 candidate 知识卡片并进入审核队列。
5. `cancel` 对非终态任务幂等可调用；已确认/已转正的导入不可回退。

#### 3.1.6 candidate 生成规则

```yaml
schema_version: "1"
title: {converted_title}
type: doc
status: candidate
confidence: 0.1
created: {today}
freshness_score: 1.0
visibility: {visibility}
tags: {extracted_tags}
```

目标归属写入 frontmatter 之外的文件路径：

- 项目：`knowledge/_agent/projects/{project_id}/{version}/...`
- 角色：`knowledge/_agent/roles/{role_id}/...`
- 实例：`knowledge/_agent/instances/{instance_id}/...`
- 全局：`knowledge/_agent/shared/...`

---

### 3.2 Graphify 转换契约（P1）

#### 3.2.1 定位

- 输入：项目目录 / 知识目录。
- 输出：`graph.json`、`graph.html`、Obsidian Vault。
- Weave 用 Cytoscape.js 展示图谱。
- 支持 `query / path / explain`。
- Graphify 属于 P1，与 AnyDoc 不冲突。
- Graphify 不是执行器，不进入执行器管线和限流。

#### 3.2.2 `graph.json` 建议 Schema

```json
{
  "schema_version": "1",
  "generated_at": "2026-08-24T12:00:00Z",
  "source_roots": ["projects/demo/v1", "knowledge/_agent/roles/designer"],
  "nodes": [
    {
      "id": "knowledge:demo-v1:grpc-timeout",
      "title": "gRPC 级联超时踩坑记录",
      "type": "pitfall",
      "path": "knowledge/_agent/projects/demo/v1/grpc-timeout.md",
      "visibility": "project_only",
      "tags": ["gRPC", "超时"],
      "frontmatter": {}
    }
  ],
  "edges": [
    {
      "source": "knowledge:demo-v1:grpc-timeout",
      "target": "knowledge:demo:design-guide",
      "relation": "links",
      "weight": 1.0,
      "evidence": "[[design-guide]]"
    }
  ]
}
```

#### 3.2.3 查询协议

```typescript
type GraphQueryInput = {
  query?: string
  tags?: string[]
  type?: KnowledgeType
  node_id?: string
  source?: string
}

type GraphPathInput = {
  from: string
  to: string
}

type GraphExplainInput = {
  node_id?: string
  edge_source?: string
  edge_target?: string
}
```

输出统一为 `{ ok: boolean, data: {...}, error?: ... }`。

---

### 3.3 Obsidian 契约

#### 3.3.1 P0

- 知识主存储保持 Markdown + frontmatter，天然兼容 Obsidian。
- `~/.dsh/obsidian/` 作为用户可见 Vault。
- 提供“打开 Obsidian”入口，打开 `~/.dsh/obsidian/`。
- P0 **不做双向同步**：手动编辑 Obsidian 中的文件不会被 Weave 自动覆盖，也不会自动反向写回 `_agent`。
- 若用户手动在 Obsidian 中修改文件，P0 不保证自动 index refresh；P1 再评估。

#### 3.3.2 P1

- 支持 `[[双链]]` 作为轻量知识关联。
- Graphify 可将生成结果输出到 Obsidian Vault。
- 后续同步方案另行评估。

---

### 3.4 转换器与执行器的边界

| 能力 | AnyDoc | Graphify | Obsidian | 执行器 |
| --- | --- | --- | --- | --- |
| 是否执行器 | 否 | 否 | 否 | 是 |
| 是否通过 `ctx.subagents.start` | 否 | 否 | 否 | 是 |
| 是否受进程限流 | 否 | 否 | 否 | 是 |
| 是否受执行器熔断 | 否 | 否 | 否 | 是 |
| 产出形态 | Markdown / candidate 知识 | 图谱文件 | Vault 文件 | 任务结果 / 沉淀标记 |

---

## 4 验收规格（AC 列表）

### 4.1 验收总览

| AC ID | 优先级 | 模块 | 验收描述 |
| --- | --- | --- | --- |
| AC-IMPORT-001 | P0 | 导入 | 支持白名单文件类型的上传与创建导入任务 |
| AC-IMPORT-002 | P0 | 导入 | 不支持的文件类型给出明确错误，不创建导入任务 |
| AC-IMPORT-003 | P0 | 导入 | 导入全链路：上传 → 转换 → 预览 → 确认 → candidate |
| AC-IMPORT-004 | P0 | 导入 | 未确认前不写入 active 知识库 |
| AC-IMPORT-005 | P0 | 导入 | 转换失败不污染知识目录，临时文件隔离 |
| AC-IMPORT-006 | P0 | 导入 | 归属选择（项目/角色/实例/全局）写入正确路径 |
| AC-CONVERT-001 | P0 | AnyDoc | 所有支持格式至少一个最小可转换样本通过 |
| AC-CONVERT-002 | P0 | AnyDoc | 转换结果为 GitHub-Flavored Markdown 并可预览 |
| AC-CONVERT-003 | P0 | AnyDoc | 导入过程不执行文件内宏/脚本 |
| AC-ROLE-001 | P0 | 团队 | `team.yaml` 中角色 executor 未注册时团队加载失败 |
| AC-ROLE-002 | P0 | 角色学习 | 角色导入文档后，执行任务 prompt 中可见相关知识 |
| AC-ROLE-003 | P0 | 角色学习 | 同一角色在不同项目/版本下检索结果隔离正确 |
| AC-ROLE-004 | P0 | 沉淀 | 任务失败/高效产出的沉淀条目能进入 candidate 队列 |
| AC-ROLE-005 | P0 | 团队 | 阶段→角色绑定：模板阶段按 roles.stages 绑定唯一角色；未命中兜底（阶段=角色 id；仍无则 configuration_error）；matcher 未命中按 default_difficulty（HI-4） |
| AC-TASK-001 | P0 | 任务 | 提交任务后生成 DAG，任务 ID 连续且全局唯一 |
| AC-TASK-002 | P0 | 任务 | 状态机与 TDD §2.1.5 权威矩阵完全一致（32 条转移逐条可触发），非法转移被拒绝 |
| AC-TASK-003 | P0 | 任务 | 失败终态传播到所有 WAITING/BLOCKED 下游为 SKIPPED |
| AC-TASK-004 | P0 | 任务 | 上游 retry/skip 后非 override 的 SKIPPED 下游恢复 WAITING/BLOCKED |
| AC-TASK-005 | P0 | 任务 | SKIPPED 重激活迭代保护上限为 100 次 |
| AC-TASK-009 | P0 | 任务 | DAG 持久化：tasks.dag_id 与 dags/edges 表正确写入；getDag 三表联合读取恢复完整 DAG（HI-3） |
| AC-TASK-006 | P0 | 反馈 | 保温期 1800 秒超时后任务 CLOSED |
| AC-TASK-007 | P0 | 反馈 | `accept/revise/cancel` 意图识别正确 |
| AC-TASK-008 | P0 | 反馈 | 修订 prompt 包含上一版输出和用户反馈历史 |
| AC-EXEC-001 | P0 | 执行器 | `spawn`/`fork` 必过；Codex / Claude Code / ACP provider 在 P0-EXEC-021 执行器 Bundle 安装并启用后通过 `ctx.subagents.start` 调用并返回（若与 DSH `0.1.1-rc.2` 不兼容，按任务规划方案B：其余为可选 Providers，安装后验证） |
| AC-EXEC-002 | P0 | 执行器 | `ExecutorRegistry` 正确分类 provider 并支持 get/list/kindOf |
| AC-EXEC-003 | P0 | 执行器 | 未注册执行器导致团队配置校验失败并给出明确错误 |
| AC-EXEC-004 | P0 | 执行器 | 非交互模式下需批准操作被拒：子代理以输出/诊断文本明确说明（DSH 无 permission_denied stopReason）；Weave 按 stopReason 正常映射，`permission_denied` 为可选启发式识别，不作 P0 强制 |
| AC-EXEC-005 | P0 | 执行器 | 进程数超限排队等待，不触发熔断 |
| AC-EXEC-006 | P0 | 执行器 | 断路器 ACTIVE → BANNED → COOLDOWN → ACTIVE 状态机正确 |
| AC-EXEC-007 | P0 | 执行器 | 委托链深度 ≤3、闭环检测、等待超时 300s 防护生效 |
| AC-KNOW-001 | P0 | 知识 | 四层知识目录与三目录隔离正确 |
| AC-KNOW-002 | P0 | 知识 | frontmatter 必须字段完整，`schema_version="1"` |
| AC-KNOW-003 | P0 | 知识 | candidate → active（approve）/ candidate → deprecated（reject）审核队列正确（HI-5）；active → deprecated | superseded 生命周期与人工 supersede 归 P1（AC-KNOW-003 附注：P0 仅覆盖审核转正/拒绝） |
| AC-KNOW-004 | P1 | 知识 | 置信度模型与新鲜度计算正确 |
| AC-KNOW-005 | P0 | 知识 | 注入限制 max_entries / max_chars_per_entry / max_total_chars 生效（ME-1：F-12 为 P0，AC 同步 P0） |
| AC-OBSIDIAN-001 | P0 | Obsidian | 知识库文件可直接被 Obsidian 打开 |
| AC-OBSIDIAN-002 | P0 | Obsidian | “打开 Obsidian”入口路径正确指向 `~/.dsh/obsidian/` |
| AC-OBSIDIAN-003 | P0 | Obsidian | P0 手动编辑不自动覆盖、无双向同步 |
| AC-GRAPHIFY-001 | P1 | Graphify | 能生成 `graph.json` / `graph.html` / Obsidian Vault |
| AC-GRAPHIFY-002 | P1 | Graphify | 支持 query / path / explain，Cytoscape.js 可展示 |
| AC-GRAPHIFY-003 | P1 | Graphify | Graphify 不作为执行器，不受执行器限流 |
| AC-COMPAT-001 | P0 | 兼容 | DSH 版本基线满足 `0.1.1-rc.2` 且含 `ctx.subagents` |
| AC-COMPAT-002 | P0 | 兼容 | 单机单进程，无自研 spawn/kill 进程 |
| AC-COMPAT-003 | P0 | 兼容 | 单活动版本约束：同一会话同一时间只操作一个活动版本 |
| AC-COMPAT-004 | P0 | 兼容 | 执行器四类收敛：DSH 子代理 / Codex / Claude Code / ACP |
| AC-COMPAT-005 | P0 | 兼容 | DSH 设置页不出现 Weave 条目，Weave 入口位于左侧导航 |
| AC-AUDIT-001 | P0 | 审计 | 核心事件写入 audit 日志且字段完整 |
| AC-RECOVERY-001 | P0 | 恢复 | 崩溃重启后任务状态、导入状态和知识元数据一致 |

### 4.2 AC 明细（GWT 示例展开）

以下为关键 P0 AC 的 Given-When-Then；其余 AC 按同一模板展开。

#### AC-IMPORT-003：导入全链路

- **Given** 用户已登录 DSH 会话，且 `~/.dsh/knowledge` 目录可写
- **When** 用户通过 Web 上传一份 `.pdf`，选择归属“角色/designer”，执行 `convert → preview → confirm`
- **Then** 系统按 `uploaded → converting → converted → previewing → reviewing` 流转，确认后生成 `candidate` 知识卡片，写入 `knowledge/_agent/roles/designer/`，`knowledge_meta.status='candidate'`
- **并且** 确认前 `knowledge/_agent` 中不出现 active 知识，审计记录导入确认事件。

#### AC-IMPORT-004：未确认不写入 active

- **Given** 用户上传并转换成功，但未执行 confirm
- **When** 查询知识库 active 知识
- **Then** 不应出现该导入内容，且 `import_jobs.status != 'confirmed'`

#### AC-ROLE-001：未注册执行器导致校验失败

- **Given** `team.yaml` 中某角色 `executor: not-registered`
- **When** `TeamManager.validateTeam(team, executorRegistry)` 被调用
- **Then** 团队加载失败，返回 `executor_unavailable`，不进入任务调度
- **并且** CLI/Web 展示可读错误信息。

#### AC-TASK-002：状态机非法转移拒绝

- **Given** 任务处于 `WAITING`
- **When** 尝试直接置为 `CLOSED`
- **Then** 系统拒绝该转移，返回 `invalid_status_transition`
- **并且** 审计日志不写非法转移。

#### AC-TASK-008：修订上下文注入

- **Given** 任务已完成，`SessionTracker` 已记录 `previous_result` 与 `user_feedback`
- **When** 用户发送 `revise` 反馈并触发修订执行
- **Then** `DelegationService.buildPrompt` 生成的 prompt 包含 `## 之前的版本与用户反馈`
- **并且** 包含 `previous_result` 摘要、反馈历史、当前修订次数。

#### AC-EXEC-001：执行器调用（spawn/fork 必过 + Bundle 安装后验证）

- **Given** DSH 已注册 `spawn`、`fork` provider；`codex`、`claude-code`、`acp`（ACP；`zcode` 为 mock 占位名，真实 provider 名为 `acp`，分类规则一致）provider 随 P0-EXEC-021 执行器 Bundle 安装并启用（基线 preset 默认禁用，见审核报告 E6）
- **When** `DelegationService.executeTask` 分别调用四个执行器
- **Then** 每次调用均通过 `ctx.subagents.start(name, { prompt: ContentBlock[], parent, signal })` 发起，返回 `SubagentRun`；`await run.result` 得到 `SubagentResult`（`output: ContentBlock[]`、`stopReason`），Weave 映射为 `SubagentTaskOutput`（见 2.4.2）
- **并且** 不出现 Weave 自研 spawn/kill 进程逻辑；子代理以 `error/refusal/max-tokens` 结束时 `run.result` resolve（不 reject），任务按 2.4.3 映射为 FAILED。
- **并且** `spawn`/`fork` 为必过项；`codex`/`claude-code`/`acp`（ACP；`zcode` 为 mock 占位名，真实名为 `acp`）在 Bundle 与 DSH `0.1.1-rc.2` 兼容时必过，不兼容时降级为“安装后验证”（方案B，见任务规划 §2/§8）。

#### AC-EXEC-005：进程数限流排队

- **Given** 某执行器已满并发槽位
- **When** 新任务请求执行
- **Then** 任务进入等待队列，不立即失败，不触发断路器
- **并且** 前序任务释放后自动继续执行。

#### AC-OBSIDIAN-002：Obsidian 入口

- **Given** `~/.dsh/obsidian/` 存在
- **When** 用户点击 Web 页面“打开 Obsidian”
- **Then** 系统打开该路径，且不会复制/覆盖用户手改内容。

---

## 5 兼容性约束

### 5.1 平台与运行环境

| 约束 | 规格 |
| --- | --- |
| 底座 | DSH `0.1.1-rc.2` 或更高且必须包含 `ctx.subagents` API |
| 语言 | TypeScript |
| 部署 | 单机单进程；Weave 作为 DSH 插件运行 |
| 进程管理 | 由 DSH 内部实现；Weave 不自行 spawn/kill 进程 |
| 会话保持 | DSH 子代理为 ephemeral 线程；Weave 通过 SessionTracker + prompt 注入保持修订上下文 |
| 持久化 | SQLite + WAL + `SingleWriterQueue` 串行写入 |
| 知识存储 | Markdown + YAML frontmatter |
| 检索 | BM25 + jieba |
| UI | React 18 + Ant Design v5 + Cytoscape.js |

### 5.2 数据兼容性

1. 所有业务配置、frontmatter、图谱 JSON 的 `schema_version` 必须为 `"1"`。
2. `tasks.db / feedback.db / knowledge_meta.db / core.db` 表结构按第 2 节；升级仅允许新增列，不允许删除/重命名 P0 字段。
3. `feedback_routes` 不包含 `session` 字段；v0.1.0-rc 中 `session` 相关字段已移除，由 `SessionTracker` 提供修订上下文。
4. 知识文件必须位于 `_agent/_human/_views` 三目录之一；`_human` 为人工编辑区，人工修改可 supersede `_agent`，但 Agent 不自动覆盖 `_human`。
5. 文件路径中的项目与版本隔离：`projects/{project_id}/{version}/`；同一会话同一时间只允许一个活动版本。

### 5.3 执行器兼容性

1. P0 只支持四类执行器：`dsh_subagent`、`codex`、`claude_code`、`acp`。
2. 全部通过 `ctx.subagents.start(executorId, request)` 调用；不区分 source/command 分支。
3. 非 P0 自定义 CLI 执行器仅作为没有 ACP 时的后备方案，可用 `executors.yaml` 包装为自定义 SubagentProvider，但不得绕过 `ctx.subagents`。
4. `ExecutorRegistry` 必须以 `ctx.subagents.list()` 为唯一发现来源。
5. 执行器无需感知 Weave；Weave 只做状态跟踪、prompt 注入、结果映射。

### 5.4 安全与操作模式兼容性

| 场景 | 约束 |
| --- | --- |
| 非交互模式 | 执行中需用户批准的操作由子代理内层拒绝，表现为输出/诊断文本；Weave 按 stopReason 正常映射（`permission_denied` 为可选启发式识别，非 DSH 枚举；不作 P0 强制） |
| 子代理记忆 | ephemeral 线程无跨任务记忆；不允许假设子代理保存上一轮上下文 |
| 文件导入 | 不执行文档内宏/脚本 |
| 手工编辑 | P0 不在后台自动覆盖 Obsidian Vault 内容 |
| 循环防护 | 委托链深度 ≤ 3；执行器重复且未完成 → 拒绝；等待超时 300s |

### 5.5 已废弃/移除的 v0.1.0-rc 行为

| 废弃项 | 替代 |
| --- | --- |
| 自研 `SubagentAdapter` | `DelegationService` 基于 `ctx.subagents.start` |
| 自研进程生命周期管理 | DSH 内部管理 |
| `SessionLifecycleManager` | `SessionTracker`（仅状态跟踪与修订上下文） |
| `feedback_routes.session` 字段 | 不再使用；修订上下文由 `SessionTracker` 记录 |
| P0 任意 command 字符串执行器 | 非 P0 后备，且需包装为 SubagentProvider |

---

## 6 术语表

| 术语 | 定义 |
| --- | --- |
| Weave | 构建在 DSH 之上的多 Agent 团队协作与知识成长框架 |
| DSH | DeepSeek Harness；提供插件系统、事件总线、会话管理、MCP/HTTP、`ctx.subagents` 原生子代理管理 |
| `ctx.subagents` | DSH 原生子代理 API：provider 注册/发现（registerProvider/getProvider/list）+ `start(name, request)` 一次性运行；`prompt=ContentBlock[]`、`parent/signal` 必填；返回 `SubagentRun`（`await result` 得 `SubagentResult{output, structured?, diagnostic?, stopReason}`）；取消经 AbortSignal、释放用 `run.dispose()` |
| ephemeral 线程 | DSH 子代理每次调用创建的临时线程；任务完成后销毁，无跨任务记忆 |
| 执行器 | 实际执行任务的 Agent/工具，包括 DSH 子代理、Codex、Claude Code、其它 ACP 工具 |
| ExecutorRegistry | 基于 `ctx.subagents.list()` 发现并分类执行器的模块 |
| DelegationService | 通过 `ctx.subagents.start` 将任务委托给执行器的模块 |
| SessionTracker | 记录修订上下文（上一版输出、用户反馈、修订次数），替代 SessionLifecycleManager |
| 保温期 | 任务从 `COMPLETED` 进入 `AWAITING_FEEDBACK` 的一段窗口，默认 1800s，可接收用户反馈/确认/取消 |
| 修订上下文注入 | 修订执行时，把上一版输出和用户反馈历史写入新 prompt 的手法 |
| DAG | 有向无环图；任务分解与依赖关系 |
| 任务状态机 | 14 态、32 条转移的任务生命周期约束 |
| SKIPPED 重激活 | 上游 retry/skip 后，非 override 的跳过任务恢复等待 |
| 四层知识 | 项目知识、角色知识、实例知识、全局知识 |
| 三目录隔离 | `_agent`（Agent 写入区）、`_human`（人工编辑区）、`_views`（动态视图） |
| candidate | 知识候选状态，初始 `confidence=0.1` |
| active | 知识转正状态，可被检索注入 |
| deprecated | 知识因过期/替代而被弃用 |
| superseded | 知识被人工或新知识显式替代 |
| freshness_score | 知识新鲜度评分，`[0,1]`，随衰减/校验变化 |
| 置信度 | 知识可信度评分，`[0,1]`，初始 `0.1`，阈值 `0.75` |
| 双向反思 | 失败沉淀 Pitfall，高效沉淀 Pattern；任务向知识回流 |
| AnyDoc | 文档转 Markdown 的统一转换器；属于知识导入源/转换器，不是执行器 |
| Graphify | 知识图谱引擎；P1；生成 `graph.json / graph.html / Obsidian Vault` |
| Obsidian Vault | 用户可见的 Markdown 知识库，路径 `~/.dsh/obsidian/` |
| 导入管线 | `upload → convert → preview → confirm → review → active` 的知识导入流程 |
| ImportJob | 一次导入任务的记录模型 |
| ProcessLimiter | 按执行器限制并发与小时频率，超限排队不熔断 |
| CircuitBreaker | 熔断状态机 `ACTIVE → BANNED → COOLDOWN → ACTIVE`，连续失败 ≥ 3 触发 |
| SingleWriterQueue | SQLite 写操作串行化队列 |
| MCP Tool | 通过 DSH MCP Server 暴露的 `weave_*` 工具 |
| CLI | DSH 会话内 `/weave ...` 命令 |
| AC | Acceptance Criteria，验收标准；本规格用 `AC-模块-编号` 标识 |
| schema_version | 配置/知识/图谱 JSON 的版本字段，当前固定 `"1"` |

---

## 附：与架构文档的映射

| 本文档章节 | 上游章节 |
| --- | --- |
| 1.2 MCP Tools | 架构 11.1 |
| 1.3 CLI | 架构 11.2 |
| 1.4 HTTP | 架构 12.1 |
| 1.5 内部服务 | 架构 4.x、5.x、SDD 2.x |
| 2.1-2.6 数据模型 | 架构 9.x、SDD 5.x |
| 2.5 导入记录 | 架构 附录 C.1、SDD 2.6 |
| 3.1 AnyDoc | 架构 附录 C.1、FDD 4.2 |
| 3.2 Graphify | 架构 附录 C.4、FDD 4.7 |
| 3.3 Obsidian | 架构 附录 C.3、FDD 4.8 |
| 4 验收规格 | 架构 15.1、FDD 7.1 |
| 5 兼容性 | 架构 1.3、1.4、ADR-030~033 |
| 6 术语表 | 全文 |

---

> 本文档为 TDD/Spec 基线；任何接口或数据模型变更必须先更新 ADR 与本文件，再同步 FDD/SDD 与架构文档。
