# AgentTeams Fork 软件设计文档（SDD）

> 配套文档：
> - 决策与影响评估：`doc/decisions/11-agent-teams-fork-迁移决策.md`
> - 详细设计：`doc/design/12-AgentTeams-Fork-详细设计.md`
> - 任务拆解：`doc/tasks/13-AgentTeams-Fork-任务文档.md`
>
> 状态：v1（设计定稿，未实施）

## 1 总体设计

### 1.1 文档定位

本文档定义 weave 接入 fork 版 dsh-agent-teams 的软件设计，覆盖：

- fork 侧最小扩展点；
- weave 侧集成模块；
- 执行器抽象；
- 数据模型与持久化；
- 错误处理、部署与测试。

### 1.2 设计目标

1. **核心外置**：队伍、成员、任务、调度、质量门禁由 fork 的 dsh-agent-teams 提供，weave 不再自研任务引擎。
2. **配置保留**：团队配置继续以 `~/.dsh/teams/*.yaml` 为唯一来源。
3. **能力桥接**：知识库、会话反思、ACP 执行器、DSH fork 子代理通过最小接口接入 fork。
4. **版本解耦**：主线运行于 DSH `0.1.1-rc.2`；`MemberTransport` 抽象不绑定 alpha API，未来可切换。
5. **旧语义不迁移**：不复制 weave 14 态状态机、通知旁路、回合守卫等旧内部细节。

### 1.3 架构原则

- **单一真相**：团队/任务状态只存 fork 的 `.agent-teams/`；weave 不得直接写该目录。
- **适配而非复制**：weave 只做配置映射、事件桥接、执行器包装。
- **最小补丁**：fork 只新增字段、接口、钩子，不重写调度核心。
- **失败不阻断**：知识注入、反思等增强能力失败时降级，不得影响 fork 主流程。
- **小步验证**：每个模块独立测试，再进集成。

### 1.4 总体架构

```
┌────────────────────────────────────────────────────────────┐
│ weave 集成层                                                 │
│                                                            │
│  TeamConfigProfileMapper   yaml → fork profile              │
│  SessionBootstrap          会话启用 → fork.bootstrapTeam    │
│  KnowledgeBridge           知识注入                          │
│  ReflectionBridge          终态 → 反思沉淀                   │
│  ExecutorSessionStore      ACP 会话索引 v2                  │
│  AcpMemberTransport        ACP 执行器包装                    │
└──────────────┬─────────────────────────────────────────────┘
               │ 注册 transport / hooks
┌──────────────▼─────────────────────────────────────────────┐
│ fork: dsh-agent-teams                                       │
│  types / state / scheduler / tools / members / quality      │
│  gates / ActivityPanel                                      │
│                                                             │
│  扩展：TeamMember.executor、MemberTransport、bootstrapTeam、 │
│        enrichAssignment、onTaskSettled                      │
└─────────────────────────────────────────────────────────────┘
```

### 1.5 模块清单

| 模块 | 位置 | 责任 |
|---|---|---|
| fork 核心 | fork `src/` | 团队/任务/调度唯一实现 |
| `executor` 字段 | fork `types.ts` / `profiles.ts` | 成员执行器选择 |
| `MemberTransport` | fork `member-transport*.ts` | 成员执行抽象 |
| `bootstrapTeam` | fork `tools.ts` | 程序化建队 |
| `AgentTeamsHostHooks` | fork `index.ts` | 派单增强/终态回调 |
| `TeamConfigProfileMapper` | weave | yaml → profile |
| `SessionBootstrap` | weave | 会话启用建队 |
| `KnowledgeBridge` | weave | 知识注入 |
| `ReflectionBridge` | weave | 反思沉淀 |
| `ExecutorSessionStore` | weave | ACP 会话索引 |
| `AcpMemberTransport` | weave | ACP 执行器包装 |

## 2 模块设计

### 2.1 fork 核心（复用）

fork 的 `dsh-agent-teams v0.1.14` 提供：

- `state.ts`：TeamState / TeamTask / TeamMember / mailbox / 锁；
- `scheduler.ts`：kickTeam / kickMember / attempt / 自动续领；
- `tools.ts`：13 个 `agent_teams_*` 工具；
- `members.ts`：continuable 成员 spawn / followup / interrupt；
- `quality-gates.ts`：需求→实现→验证→审查→修复→集成；
- `ActivityPanel`：Web 团队面板。

约束：**不得修改以上核心语义**，只能通过下述扩展点接入。

### 2.2 executor 字段

`TeamMember` 增加：

```ts
executor?: string
```

`TeamProfileMemberConfig` 增加：

```ts
executor?: string
```

解析顺序：

1. `member.executor` 非空 → 使用该执行器；
2. 否则回落插件全局 `memberProvider`。

### 2.3 MemberTransport 抽象

```ts
export type MemberRuntimeStatus = 'idle' | 'working'

export interface MemberDeliverHooks {
  onSettled(outcome: MemberSettledOutcome): Promise<void>
  onStatusChange(member: TeamMember, status: MemberRuntimeStatus): void
}

export interface MemberTransport {
  readonly kind: string
  provision(input: MemberProvisionInput): Promise<{ memberId: string }>
  isAvailable(member: TeamMember): boolean
  deliver(input: MemberDeliverInput): Promise<{ accepted: boolean }>
  interrupt(member: TeamMember): void
  dispose(member: TeamMember): Promise<void>
}
```

注册表：

```ts
class MemberTransportRegistry {
  register(kind: string, transport: MemberTransport): () => void
  resolve(member: TeamMember, fallbackKind: string): MemberTransport
}
```

### 2.4 DshMemberTransport

用于 `spawn` / `fork`。

- `provision` → 原 `spawnMember`；
- `deliver` → 原 `deliverToMember`；
- `interrupt` → 原 `interruptMember`；
- `isAvailable` → 原 `isMemberAvailable`（宿主 `agent/status`）。

任务状态由子代理调用 `agent_teams_claim_task / update_task` 完成。

### 2.5 fork 钩子服务

```ts
export interface AgentTeamsHostHooks {
  enrichAssignment?(input: {
    team: TeamState
    member: TeamMember
    ticket: DispatchTicket
    prompt: string
  }): Promise<string>

  onTaskSettled?(input: {
    team: TeamState
    task: TeamTask
    member?: TeamMember
    output: string
    terminal: 'completed' | 'failed' | 'cancelled'
  }): Promise<void>
}
```

约束：

- `enrichAssignment` 抛错 → 使用原始 prompt；
- `onTaskSettled` 抛错 → 只记日志，不回滚状态。

### 2.6 bootstrapTeam

```ts
export interface BootstrapTeamInput {
  captain: Agent
  teamName: string
  teamId: string
  profileName: string
  description?: string
  approval: 'automatic' | 'required'
}

export async function bootstrapTeam(
  runtime: AgentTeamsRuntime,
  input: BootstrapTeamInput,
): Promise<{ team: TeamState; created: boolean }>
```

语义：

1. 锁内 `findTeamByCaptain`；
2. 命中 → 复用；
3. 未命中 → 复用 `initializeProfileTeam` 路径建队；
4. 建队后 `scheduler.kickTeam`。

### 2.7 TeamConfigProfileMapper

weave 新文件 `team-profile-mapper.ts`。

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

映射：

| yaml | profile |
|---|---|
| `team_id` | profileName |
| `team_id + '-' + shortSessionId`（sanitize） | teamId |
| `name` | teamName |
| `description` | description |
| `roles[].id` | members[].name |
| `roles[].name` | members[].role |
| `roles[].executor` | members[].executor |
| `roles[].provider` | members[].provider |
| `roles[].model` | members[].model |
| `roles[].thought_level` | members[].reasoning_effort |
| `roles[].personality` | members[].executionPrompt |
| `roles[].fallback_*` | members[].fallback |
| `roles[].stages / strengths / bias` | profile.protocol |
| `roles[].mode` | profile.protocol（暂定） |

### 2.8 SessionBootstrap

weave 新文件 `session-bootstrap.ts`。

流程：

1. `TeamManager.resolveSessionTeam(sessionId)`；
2. `teamConfigToProfile`；
3. `bootstrapTeam`；
4. 持久化绑定 `sessionId ↔ yaml team_id ↔ teamId`；
5. `KnowledgeBridge.injectOnTeamCreated`；
6. notice 结果。

失败处理：建队失败 → 回滚绑定，会话 notice 失败原因。

### 2.9 KnowledgeBridge

weave 新文件 `knowledge-bridge.ts`。

- `injectOnTeamCreated`：按角色检索，追加到 member `executionPrompt` 与 team `protocol`；
- `enrichAssignment`：按 ticket 检索，追加派单 prompt；
- 检索/异常降级为空注入；
- 成员工具白名单放行 `weave_knowledge_search`。

### 2.10 ReflectionBridge

weave 新文件 `reflection-bridge.ts`。

映射：

```
TeamTask.id        → taskId
member.executor    → executor
member.role/name   → roleId
yamlTeamId         → projectId
teamId(会话实例)    → version
task.output        → outputText
task.subject       → taskSubject
```

调用 `ReflectionService.depositFromOutput`；异常不阻断 fork。

### 2.11 ExecutorSessionStore

weave 新文件 `executor-session-store.ts`。

路径：

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
      "acpSid": "acp-xxx",
      "updatedAt": 1787934986868
    }
  }
}
```

`sessionKeyOf`：

```ts
`${sha1(realpath(workspace))}:${teamId}:${roleId}`
```

兼容：旧记录无 `type` / 带 `cwd` 只读兼容；损坏文件按空索引处理。

### 2.12 AcpMemberTransport

weave 新文件 `acp-member-transport.ts`。

- `provision`：合成稳定 `memberId = acp:<teamId>:<memberName>`；
- `isAvailable`：内存 activeRun 表；
- `deliver`：
  1. 标记 working；
  2. `ExecutorSessionStore.resolve(sessionKey)`；
  3. `AcpSessionProvider.start({ sessionKey, resumeSessionId, prompt, runtime })`；
  4. 返回 accepted；
  5. `run.result` 完成后调用 `onSettled`，再置 idle；
- `interrupt`：abort + ACP cancel；
- `dispose`：abort、等待 settle、清表。

ACP 成员不调 `agent_teams_*`；状态由 fork 的主机侧 `onSettled` 适配器回写。

## 3 关键接口汇总

```ts
// fork
MemberTransport
MemberTransportRegistry
AgentTeamsHostHooks
BootstrapTeamInput / bootstrapTeam

// weave
TeamConfigProfileMapper.teamConfigToProfile
SessionBootstrap.enableTeam
KnowledgeBridge.injectOnTeamCreated / enrichAssignment
ReflectionBridge.onTaskSettled
ExecutorSessionStore.sessionKeyOf / resolve / remember
AcpMemberTransport implements MemberTransport
```

## 4 数据流

### 4.1 会话启用团队

```
用户消息
  → pre-step hook（解析“启用 <团队>”）
  → TeamManager.bind
  → teamConfigToProfile
  → bootstrapTeam
  → 持久化绑定
  → KnowledgeBridge.injectOnTeamCreated
  → notice
```

### 4.2 DSH 成员派发

```
fork scheduler.kickMember
  → DshMemberTransport.isAvailable
  → hooks.enrichAssignment
  → DshMemberTransport.deliver
  → ctx.subagents.followup
  → 子代理调用 agent_teams_* 写状态
```

### 4.3 ACP 成员派发

```
fork scheduler.kickMember
  → AcpMemberTransport.isAvailable
  → hooks.enrichAssignment
  → AcpMemberTransport.deliver
  → ExecutorSessionStore.resolve
  → AcpSessionProvider.start
  → run.result
      → onSettled（主机侧回写）
      → onStatusChange(idle)
      → 下一单 kick
```

### 4.4 任务终态与反思

```
agent_teams_update_task（终态）
  → fork 提交状态
  → appendTeamEvent('agent-teams/task-updated')
  → hostHooks.onTaskSettled
  → ReflectionBridge
  → ReflectionService.depositFromOutput
  → KnowledgeStore + AuditLog
```

## 5 数据模型

### 5.1 fork 团队状态（唯一任务真相）

- 目录：`<workspace>/.agent-teams/<teamId>/`
- `team.json`：TeamState
- `inbox/`：成员邮箱 JSONL
- `teamId` 会话级唯一：`sanitizeKey(yamlTeamId + '-' + shortSessionId)`

### 5.2 yaml 团队配置（配置真相）

- 目录：`~/.dsh/teams/*.yaml`
- 结构：沿用现有 `TeamConfig / RoleConfig`，新增字段暂无。

### 5.3 会话绑定

- weave `team_bindings`：
  - `session_id`
  - `yaml_team_id`
  - `fork_team_id`
- fork `TeamState.captainSessionId` 为执行态真相。

### 5.4 ACP 会话索引

见 2.11。

## 6 错误处理

| 场景 | 行为 |
|---|---|
| profile 映射失败 | 不建队，notice 原因 |
| fork 建队失败 | 回滚绑定，notice |
| transport 未注册 | fork 原风格明确报错 |
| deliver 失败 | fork 原 rollback（attemptId 校验） |
| ACP run 失败/中止 | `onSettled(failed=true)`，保留 partial output |
| 知识注入异常 | 降级为空，不阻断派单 |
| 反思异常 | warn，不阻断 fork |
| 索引损坏 | 按无记录处理 |

## 7 部署与配置

- DSH 版本：`0.1.1-rc.2`（主线，不升级）。
- profile：现有 `web` profile 继续使用；后续挂载 fork 插件。
- 团队配置：`~/.dsh/teams/`。
- fork stateDir：`.agent-teams`。
- ACP 索引：`~/.dsh/weave/acp-session-index.json`。
- 退役模块：见决策文档 D1。

## 8 兼容性与演进

- `MemberTransport` 不依赖 alpha 类型。
- rc.2 下使用 `startContinuable / followup / interrupt`；
- alpha 预研线可切换：
  - `childId` 预分配；
  - `subagent/end` 生命周期事件；
  - 标准 ACP resume/model/MCP。
- 两条线不并行修改核心。

## 9 测试与验收

### 9.1 单元测试

- fork：registry、profile executor、bootstrapTeam、hooks；
- weave：profile 映射、sessionKey、索引 v2、knowledge bridge、reflection bridge、AcpMemberTransport mock。

### 9.2 集成测试

- spawn/fork/acp 各跑通最小 DAG；
- ACP 重启复用；
- 多会话团队隔离。

### 9.3 验收门禁

```
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e:harness
```

## 10 修订记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1 | 2026-08-30 | 首版：基于决策文档 11 与详细设计 12 |
