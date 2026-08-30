# 12. AgentTeams Fork 详细设计

> 配套决策文档：`doc/decisions/11-agent-teams-fork-迁移决策.md`
> 状态：详细设计 v1（尚未实施）
> DSH 主线：`0.1.1-rc.2`；fork 源：`dsh-agent-teams v0.1.14`

## 1. 目标与非目标

### 1.1 目标

- 用 fork 的 dsh-agent-teams 替换 weave 自研任务/团队核心。
- 保留 yaml 团队配置，会话启用团队时按配置创建小队。
- 接入知识库、会话反思、ACP 执行器、DSH fork 子代理。
- 最小化 fork 补丁；最大复用 fork 原生能力。

### 1.2 非目标

- 不迁移 weave 14 态状态机及派生语义。
- 不自研调度循环、任务工具、团队状态存储。
- 不在本版升级 DSH alpha；alpha 仅预研。
- 不重写 fork 的质量门禁、ActivityPanel、mailbox。

## 2. 总体架构

```
┌───────────────────────────────────────────────────────────┐
│ weave 插件（集成层）                                          │
│                                                           │
│  TeamConfigProfileMapper  yaml TeamConfig → TeamProfile    │
│  SessionBootstrap         会话启用 → fork.bootstrapTeam    │
│  KnowledgeBridge          知识检索 → protocol/execution   │
│  ReflectionBridge         任务终态 → ReflectionService     │
│  ExecutorSessionStore     ACP sessionKey 索引 v2          │
│  AcpMemberTransport       实现 fork.MemberTransport        │
└───────────────┬───────────────────────────────────────────┘
                │ 注册 transport / 钩子
┌───────────────▼───────────────────────────────────────────┐
│ fork: dsh-agent-teams（团队引擎，唯一任务/团队真相）            │
│                                                           │
│  types/state/scheduler/tools/members/quality-gates/UI      │
│  + TeamMember.executor 字段                                │
│  + MemberTransport 接口与 transport 注册表                  │
│  + bootstrapTeam 程序化建队入口                             │
│  + enrichAssignment / task-settled 扩展钩子                 │
└───────────────────────────────────────────────────────────┘
```

原则：

- 任务状态、调度、团队状态只有 fork 一个真相。
- weave 只能通过接口/事件读改 fork，禁止直接写 `.agent-teams/`。

## 3. 核心接口设计

### 3.1 MemberTransport

fork 新增 `src/member-transport.ts`：

```ts
export type MemberRuntimeStatus = 'idle' | 'working'

export interface MemberDeliverHooks {
  onSettled(outcome: {
    member: TeamMember
    ticket: DispatchTicket
    output: string
    failed: boolean
    stopReason?: string
  }): Promise<void>
  onStatusChange(member: TeamMember, status: MemberRuntimeStatus): void
}

export interface MemberDeliverResult {
  accepted: boolean
}

export interface MemberTransport {
  /** 执行器类型：'dsh' | 'acp' | 未来扩展 */
  readonly kind: string

  /** 创建/恢复成员执行身份；返回 fork 认可的 member.id */
  provision(input: MemberProvisionInput): Promise<{ memberId: string }>

  /** 成员当前是否可派发下一单 */
  isAvailable(member: TeamMember): boolean

  /** 派发一个 ticket；底层是 followup 或 ACP start */
  deliver(input: MemberDeliverInput): Promise<MemberDeliverResult>

  /** 中断当前执行 */
  interrupt(member: TeamMember): void

  /** 释放资源 */
  dispose(member: TeamMember): Promise<void>
}

export interface MemberProvisionInput {
  team: TeamState
  member: TeamMember
  captain: Agent
  signal: AbortSignal
}

export interface MemberDeliverInput {
  team: TeamState
  member: TeamMember
  ticket: DispatchTicket
  prompt: string
  hooks: MemberDeliverHooks
  signal: AbortSignal
}
```

### 3.2 Transport 注册表

fork 新增 `src/member-transport-registry.ts`：

```ts
export class MemberTransportRegistry {
  register(kind: string, transport: MemberTransport): () => void
  get(kind: string): MemberTransport
  resolve(member: TeamMember, fallbackKind: string): MemberTransport
}

export const MEMBER_TRANSPORT_SERVICE = 'agentTeams.memberTransports'
```

解析规则：

1. `member.executor` 有值 → 按其 kind 查找；
2. 否则回落到插件全局 `memberProvider`；
3. 找不到 → 抛出 fork 现有风格的明确错误，不静默降级。

### 3.3 ExecutorSessionStore（weave）

```ts
export interface ExecutorSessionRecord {
  /** 后端 agent 标识：当前 'zcode'，未来 'xxx-agent' */
  type: string
  acpSid: string
  updatedAt: number
}

export interface ExecutorSessionStore {
  sessionKeyOf(input: {
    workspace: string
    teamId: string
    roleId: string
  }): string

  resolve(sessionKey: string): Promise<{ resumeSessionId?: string }>
  remember(sessionKey: string, record: ExecutorSessionRecord): Promise<void>
}
```

索引文件（暂不迁项目目录）：

```
~/.dsh/weave/acp-session-index.json
```

Schema v2：

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

兼容规则：

- 旧记录无 `type` / 带 `cwd` → 只读兼容；
- 新写入只写 `type / acpSid / updatedAt`。

### 3.4 扩展钩子

fork 新增：

```ts
export interface AgentTeamsHostHooks {
  /** 派单前增强 prompt（知识库注入用） */
  enrichAssignment?(
    input: {
      team: TeamState
      member: TeamMember
      ticket: DispatchTicket
      prompt: string
    },
  ): Promise<string>

  /** 任务到达终态后触发（反思/通知用） */
  onTaskSettled?(input: {
    team: TeamState
    task: TeamTask
    member?: TeamMember
    output: string
    terminal: 'completed' | 'failed' | 'cancelled'
  }): Promise<void>
}

export const AGENT_TEAMS_HOOKS_SERVICE = 'agentTeams.hostHooks'
```

### 3.5 程序化建队

fork 从 `tools.ts` 抽出可复用入口：

```ts
export interface BootstrapTeamInput {
  captain: Agent
  teamName: string
  teamId: string          // 由 weave 按“配置team + 会话短id”生成
  profileName: string
  description?: string
  approval: 'automatic' | 'required'
}

export interface BootstrapTeamResult {
  team: TeamState
  created: boolean
}

export async function bootstrapTeam(
  runtime: AgentTeamsRuntime,
  input: BootstrapTeamInput,
): Promise<BootstrapTeamResult>
```

语义：

1. 锁内先 `findTeamByCaptain`；
2. 命中 → 返回 `created: false`；
3. 未命中 → 走 `initializeProfileTeam` 现有路径建队并 kick；
4. 事件沿用 `agent-teams/team-created` 等现有事件。

## 4. fork 侧改造

### 4.1 类型扩展

`src/types.ts`：

```ts
export interface TeamMember {
  // 新增：
  /** 成员执行器：spawn | fork | acp | 自定义；缺省回落到插件 memberProvider */
  executor?: string
}
```

### 4.2 profile 扩展

`src/profiles.ts`：

```ts
export interface TeamProfileMemberConfig {
  name: string
  role?: string
  /** 新增：成员执行器 */
  executor?: string
  provider?: string
  model?: string
  reasoning_effort?: string
  executionPrompt?: string
  fallback?: TeamModelFallbackConfig
}
```

校验：

- `executor` 非空字符串；
- 非法类型由 transport 注册表在 provision 时报错。

### 4.3 MemberTransport 抽取

文件：

```
src/member-transport.ts
src/member-transport-registry.ts
src/member-transport-dsh.ts     // 内置，spawn/fork
```

`MemberTransportDsh`：

- `provision` → 现有 `spawnMember` 逻辑
- `deliver` → 现有 `deliverToMember`
- `interrupt` → 现有 `interruptMember`
- `isAvailable` → 现有 `isMemberAvailable`
- `dispose` → 现有 retired-member guard / interrupt 兜底

### 4.4 scheduler 改造

`src/scheduler.ts`：

- 移除对 `deliverToMember` / `isMemberAvailable` 的直接 import；
- `kickMember` 内改为：

```ts
const transport = transports.resolve(member, config.memberProvider)
if (!transport.isAvailable(member)) return
const prompt = await hooks.enrichAssignment?.(...) ?? assignmentPrompt(ticket, ...)
const { accepted } = await transport.deliver({
  team, member, ticket, prompt,
  hooks: {
    onSettled: taskSettledAdapter,      // ACP 主机侧回写
    onStatusChange: memberStatusAdapter,
  },
  signal,
})
```

- spawn/fork 仍由子代理调 `agent_teams_*` 写状态，`onSettled` 为 no-op 兜底；
- ACP 由 transport 调用 `onSettled` 主机侧回写。

### 4.5 事件与钩子

`src/tools.ts`：

- `agent_teams_update_task` 终态分支调用 `onTaskSettled`；
- `appendTeamEvent` 继续发 `agent-teams/task-updated`；
- 新增错误处理：钩子失败只 `ctx.logger.warn`，不阻断任务状态提交。

`src/index.ts`：

- `apply(ctx, config)` 内安装 transport registry / hooks service；
- 导出类型：`MemberTransport`、`AgentTeamsHostHooks`、`BootstrapTeamInput`。

## 5. weave 侧改造

### 5.1 TeamConfigProfileMapper

新文件：`src/plugins/weave/team-profile-mapper.ts`

```ts
export function teamConfigToProfile(
  team: TeamConfig,
  sessionId: string,
): {
  profileName: string
  teamId: string
  teamName: string
  profile: TeamProfileConfig
}
```

映射规则：

| yaml | profile |
|---|---|
| `team_id` | `profileName`（stable） |
| `team_id + '-' + shortSessionId` | `teamId`（sanitize） |
| `name` | `teamName` |
| `description` | `description` |
| `roles[].id` | `members[].name` |
| `roles[].name` | `members[].role` |
| `roles[].executor` | `members[].executor` |
| `roles[].provider` | `members[].provider` |
| `roles[].model` | `members[].model` |
| `roles[].thought_level` | `members[].reasoning_effort` |
| `roles[].personality` | `members[].executionPrompt` |
| `roles[].fallback_*` | `members[].fallback` |
| `roles[].stages` / `strengths` / `bias` | 合并进 profile `protocol` |
| `roles[].mode` | 暂写入 `protocol`（待定 fork 原生字段） |

约束：

- 保持纯函数，无 I/O；
- 输出必须可被 fork `profiles.ts` 的 normalize 逻辑接受。

### 5.2 SessionBootstrap

新文件：`src/plugins/weave/session-bootstrap.ts`

流程：

1. `TeamManager.resolveSessionTeam(sessionId)`；
2. 生成 `teamId`；
3. 调 `bootstrapTeam`；
4. 持久化 `sessionId ↔ yaml team_id ↔ teamId`；
5. 触发 `KnowledgeBridge.injectOnTeamCreated`；
6. 会话 notice 只做结果反馈。

### 5.3 KnowledgeBridge

新文件：`src/plugins/weave/knowledge-bridge.ts`

```ts
export interface KnowledgeBridgeOptions {
  engine: KnowledgeEngine
  projectIdOf(team: TeamConfig): string
}

export class KnowledgeBridge {
  async enrichAssignment(input): Promise<string>
  async injectOnTeamCreated(teamConfig: TeamConfig, profile: TeamProfileConfig): Promise<void>
}
```

行为：

- `injectOnTeamCreated`：按 role 检索 `candidate/active` 知识，追加到 member `executionPrompt` 和 team `protocol`；
- `enrichAssignment`：派单时再按 ticket 关键词检索一次，追加到派单 prompt 尾部；
- 检索失败降级为空注入，不阻断建队。

### 5.4 ReflectionBridge

新文件：`src/plugins/weave/reflection-bridge.ts`

```ts
export class ReflectionBridge {
  constructor(reflection: ReflectionService, mapper: ReflectionFieldMapper)

  async onTaskSettled(input: AgentTeamsTaskSettledInput): Promise<number>
}
```

映射：

```
task.id            → taskId
member.executor    → executor
member.role/name   → roleId
yamlTeamId         → projectId
teamId(会话实例)    → version
task.output        → outputText
task.subject       → taskSubject
```

- 只处理 `completed` / `failed`；
- 失败仅 warn，不阻断 fork 事件流。

### 5.5 ExecutorSessionStore

新文件：`src/plugins/weave/executor-session-store.ts`

- 封装 `~/.dsh/weave/acp-session-index.json` 读写；
- v2 schema 见 3.3；
- 兼容旧记录；
- `sessionKeyOf`：

```ts
const fingerprint = sha1(realpath(workspace))
return `${fingerprint}:${teamId}:${roleId}`
```

### 5.6 AcpMemberTransport

新文件：`src/plugins/weave/acp-member-transport.ts`

实现 `fork.MemberTransport`：

```ts
provision:
  return { memberId: `acp:${teamId}:${member.name}` }

isAvailable:
  activeRuns.get(member.id) === undefined

deliver:
  1. 标记 activeRun，成员 working；
  2. store.resolve(sessionKey) 取 resumeSessionId；
  3. acpProvider.start({
       executor: 'acp',
       sessionKey,
       resumeSessionId,
       prompt: [{ type: 'text', text: prompt }],
       parent,
       signal,
       runtime: { model, thoughtLevel, mode } // 来自 member/团队配置
     })
  4. 返回 accepted: true
  5. run.result.then：
     - completed → hooks.onSettled({ failed: false, output })
     - 其它 → hooks.onSettled({ failed: true, output, stopReason })
     - finally → 清 activeRun，hooks.onStatusChange(idle)
  6. onSettled 由 fork 主机侧适配器调用 agent_teams_update_task 同款状态回写

interrupt:
  abort activeRun signal + acp cancel

dispose:
  abort + 等待 result settle + 清表
```

约束：

- ACP 成员不依赖子代理调 `agent_teams_*`；
- 并发上限：默认 1；`max_concurrent_tasks` 暂不实现，避免新增调度语义。

### 5.7 退役模块

实施到 P7 后移除/冻结：

```
planner.ts
scheduler.ts
delegation-service.ts
state/task-state-machine.ts
state/types.ts
session-tracker.ts
captain-turn-guard.ts
```

保留：

```
team-manager.ts        // 只做 yaml 读取/校验/bind
knowledge-engine.ts
reflection-service.ts
acp/acp-session-provider.ts
session-stream.ts      // 仅作为通知通道
```

## 6. 核心流程

### 6.1 会话启用团队

```
用户“启用 changan”
  → pre-step hook（保留现有解析）
  → TeamManager.bind(session, changan)
  → TeamConfigProfileMapper → profile + teamId
  → fork.bootstrapTeam(captain, profile, teamId)
      ├─ 已有 team（findTeamByCaptain）→ 复用
      └─ 无 → initializeProfileTeam 建队 + kick
  → KnowledgeBridge.injectOnTeamCreated
  → notice: 小队已创建/复用
```

### 6.2 spawn/fork 任务派发

```
fork scheduler.kickMember
  → transport = DshMemberTransport
  → isAvailable: 宿主 agent/status
  → enrichAssignment（知识）
  → deliver = ctx.subagents.followup
  → 子代理自己调 agent_teams_claim_task / update_task
  → fork 正常状态流转
```

### 6.3 ACP 任务派发

```
fork scheduler.kickMember
  → transport = AcpMemberTransport
  → isAvailable: activeRun 表
  → enrichAssignment（知识）
  → deliver:
       resolve sessionKey（workspaceFingerprint:teamId:roleId）
       → resumeSessionId 或新建
       → AcpSessionProvider.start
       → accepted: true
  → ACP run.result:
       → onSettled(failed=false/true)
       → fork 主机侧回写 task 状态
       → onStatusChange(idle)
       → scheduler 继续 kick
```

### 6.4 任务终态与反思

```
task 终态（fork 状态提交）
  → agent-teams/task-updated
  → hostHooks.onTaskSettled
  → ReflectionBridge
      → ReflectionService.depositFromOutput
      → KnowledgeStore + AuditLog
  → 失败仅日志，不影响 fork
```

## 7. 状态与字段映射

### 7.1 状态语义对照（仅用于 UI/迁移，不实现状态机）

| fork | 解释 | weave 旧语义去向 |
|---|---|---|
| pending | 等待领取 | WAITING/BLOCKED（依赖不满足不可领取） |
| claimed | 已领取未开始 | RUNNING 前一步 |
| in_progress | 执行中 | RUNNING |
| completed | 完成 | COMPLETED/CLOSED |
| failed | 失败 | FAILED/LOOP_TERMINATED 等由 quality-gates 表达 |
| cancelled | 取消 | CANCELLED/SKIPPED 语义由取消动作表达 |

### 7.2 字段映射

见 5.1。

## 8. 错误处理

- 建队失败：会话 notice 报告，绑定回滚，用户可重试。
- transport provision 失败：成员不落盘，错误上抛给 fork 原错误路径。
- deliver 失败：fork 现有 rollback（ticket attemptId 校验）保持不变。
- ACP run 失败：`onSettled(failed=true)`，输出保留 partial。
- 钩子失败：warn + 继续主流程。
- 索引读写失败：按无记录处理，不阻断派单。

## 9. 版本兼容

- 主线编译/运行目标：`0.1.1-rc.2`。
- `MemberTransport` 不 import alpha 专属类型。
- 预留：
  - rc.2 下 `DshMemberTransport` 用当前 `startContinuable/followup`；
  - alpha 下可切换 childId 预分配、`subagent/end` 事件。
- fork peer deps 暂不提升到 alpha；P9 单独做。

## 10. 测试设计

### fork 侧

- transport registry 解析/缺省/冲突
- DshMemberTransport 等价性（原 tests 全绿）
- profile `executor` normalize
- bootstrapTeam 复用/新建/锁内并发
- onTaskSettled 触发与失败不阻断

### weave 侧

- `teamConfigToProfile` 纯函数快照测试
- `sessionKeyOf` workspace 指纹与隔离
- `ExecutorSessionStore` v2 读写/旧记录兼容
- `KnowledgeBridge` 注入成功/检索失败降级
- `ReflectionBridge` 字段映射 + deposit 调用
- `AcpMemberTransport` mock `start/result`：working→settled→idle
- 真 zcode 冒烟：同 sessionKey 复用会话

### 集成

- spawn/fork/acp 三种团队各完成一个最小 DAG
- 重启后：
  - spawn/fork 由 fork 冷恢复
  - ACP 由索引恢复 sessionKey

## 11. 部署与配置

- 当前 `web` profile 继续使用 rc.2，新增 fork 插件行替代未来 dsh-agent-teams。
- ACP 索引路径：`~/.dsh/weave/acp-session-index.json`。
- fork stateDir：默认 `.agent-teams`。
- 团队配置：继续 `~/.dsh/teams/*.yaml`。
