# Weave 团队运行时软件设计说明书（SDD）

> 分支：`restore/own-team-engine`
> 版本：v0.1
> 状态：设计定稿，已实现

## 1. 目标

1. 接回 Weave 自有团队引擎。
2. 团队运行状态项目级管理。
3. 通信机制基于 mailbox，事件驱动。
4. 主会话值守及时响应，不卡死等待。
5. 反思/记忆进入 Weave 知识库。
6. Web 团队页签稳定可用。

## 2. 系统上下文

```text
DSH Web / CLI
   ↓
Weave 总览层（dsh-weave）
   ├─ 团队引擎层
   ├─ 执行器抽象层
   ├─ 能力层（图/知识/反思）
   └─ 呈现层（RPC / Web Client）
```

外部依赖：
- DSH Cordis 运行时
- `~/.dsh/teams/*.yaml` 团队模板
- `~/.dsh/knowledge/` 知识库
- 项目工作区

## 3. 状态归属

| 数据 | 位置 | 生命周期 |
|---|---|---|
| 团队模板 | `~/.dsh/teams/<teamId>.yaml` | 全局、长期 |
| 团队运行状态 | `<project>/.dsh/weave/team/` | 项目级 |
| 反思/记忆 | `~/.dsh/knowledge/` | 全局、长期 |
| 代码图谱 | `<project>/.graphify/` | 项目级 |
| 审计 | `~/.dsh/audit/` | 全局、长期 |

## 4. 目录设计

```text
<projectRoot>/.dsh/weave/team/
  state.json
  sessions/
    <sessionId>/
      session.json
      team.json
      dag.json
      tasks.jsonl
      members.json
      inbox/
        captain.jsonl
        <roleId>.jsonl
      notices.jsonl
      runs.jsonl
  archive/
    <sessionId>/
```

## 5. 核心组件

### 5.1 ProjectTeamStore

职责：项目团队状态唯一入口。

```ts
interface SessionTeamState {
  sessionId: string
  teamId: string
  team?: TeamConfigSnapshot
  dag?: DagRecord
  tasks: TaskRecord[]
  members: MemberRuntimeSnapshot[]
  updatedAt: string
}

interface ProjectTeamStore {
  root(projectRoot: string): string
  loadSession(projectRoot: string, sessionId: string): Promise<SessionTeamState | undefined>
  saveSession(projectRoot: string, sessionId: string, state: SessionTeamState): Promise<void>
  listSessions(projectRoot: string): Promise<string[]>
  archiveSession(projectRoot: string, sessionId: string): Promise<void>
  snapshot(projectRoot: string): Promise<ProjectTeamSnapshot>
}
```

### 5.2 Mailbox

模型：

```ts
interface MailboxMessage {
  id: string
  from: string
  to: string
  content: string
  ts: number
  deliveryClaimedAt?: number
  deliveredAt?: number
  readAt?: number
}
```

操作：

```ts
interface Mailbox {
  append(projectRoot: string, sessionId: string, to: string, message: MailboxMessage): Promise<void>
  claim(projectRoot: string, sessionId: string, to: string, ids: string[]): Promise<void>
  ack(projectRoot: string, sessionId: string, to: string, ids: string[]): Promise<void>
  release(projectRoot: string, sessionId: string, to: string, ids: string[]): Promise<void>
  unread(projectRoot: string, sessionId: string, to: string): Promise<MailboxMessage[]>
}
```

### 5.3 Scheduler

防重复派发：

```ts
interface DispatchGuard {
  taskId: string
  dispatching: boolean
  runId?: string
  settled: boolean
}
```

派发规则：

1. 只有 WAITING/RUNNING 且依赖满足才派发。
2. 同一 taskId 未完成 run 时不重复派发。
3. fork/spawn settle 后，只有任务非终态才允许重新派发。
4. 异常先写终态，再重泵。

### 5.4 OnDutyController

```ts
interface OnDutyController {
  refresh(sessionId: string): Promise<void>
  onMemberEvent(event: MemberEvent): Promise<void>
  onTurnStopping(sessionId: string): Promise<boolean>
  hasActiveWork(sessionId: string): Promise<boolean>
  hasUnread(sessionId: string): Promise<boolean>
}
```

状态：

```text
IDLE
ACTIVE
WAITING_REVIEW
```

响应 SLA：

- 成员完成/失败：立即注入队长 inbox；
- 用户消息：最高优先；
- 子代理卡死：空闲超时自动终止并告警；
- 同一事件只注入一次。

### 5.5 ReflectionSink

```ts
interface ReflectionSink {
  deposit(input: TaskSettledInput): Promise<{ deposited: string[] }>
}
```

目标：`~/.dsh/knowledge/`，禁止写入团队目录。

## 6. 执行器生命周期

### spawn
- 一次性执行；
- 完成后 settle；
- 同一 taskId 不可重复 start。

### fork
- 可续会话；
- 后续任务走 mailbox；
- 未完成前不创建新 fork。

### ACP/zcode
- 使用 sessionKey 复用；
- 同一 role/project/version 复用同一 session。

## 7. 团队页面

- 读取 ProjectTeamStore.snapshot；
- 快照包含 revision；
- revision 不变不刷新；
- 空闲零轮询；
- 错误展示明确空态，不闪烁。

## 8. 数据流

```text
用户启用团队
  → TeamManager 读模板
  → ProjectTeamStore.saveSession

队长规划任务
  → Planner → dag.json / tasks.jsonl

Scheduler 派发
  → DispatchGuard
  → Mailbox claim
  → DelegationService.start

成员完成
  → Mailbox ack
  → Scheduler 写终态
  → OnDutyController 注入队长
  → ReflectionSink 写入知识库

团队页签
  → ProjectTeamStore.snapshot
  → revision 变化时刷新
```

## 9. 错误处理

- 状态写入失败：保留旧状态，记录 audit；
- 投递失败：释放 claim，允许重试；
- 子代理失败：先写 FAILED，再唤醒队长；
- 知识沉淀失败：不阻塞任务完成。

## 10. 验收标准

1. 多项目状态隔离。
2. 同一任务不重复创建子代理。
3. 成员完成/失败后队长立即响应。
4. 无任务时主会话可结束回合。
5. 团队删除后反思仍在知识库。
6. 团队页签稳定。
