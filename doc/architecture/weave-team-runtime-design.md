# Weave 团队运行时详细设计

> 分支：`restore/own-team-engine`
> 范围：团队通信、子代理生命周期、主会话值守、团队页面、反思记忆沉淀

## 1. 问题清单与根因

| # | 问题 | 根因 |
|---|---|---|
| 1 | 团队页签不出来/闪烁 | 团队状态散落在全局 db 与旧 RPC；Web 客户端缺少稳定快照 |
| 2 | 不停新建子代理 | Scheduler 在 fork/spawn 快速 settle 后重复泵同一 WAITING 任务 |
| 3 | 主会话卡死等待唤醒 | 没有 mailbox 事件驱动；turn-stopping 只做简单守卫 |
| 4 | 通信机制弱 | 缺少角色 inbox、投递确认、去重 |
| 5 | 反思记忆位置混乱 | 反思/记忆应该进 Weave 知识库，而不是团队运行目录 |
| 6 | 团队配置与运行状态耦合 | 团队模板和运行实例没有分离 |

## 2. 目标状态

### 2.1 状态归属

```text
~/.dsh/teams/<teamId>.yaml
  团队模板（配置只读）

<projectRoot>/.dsh/weave/team/
  项目级团队运行状态

~/.dsh/knowledge/
  反思/记忆/知识沉淀
```

### 2.2 项目级状态目录

```text
<projectRoot>/.dsh/weave/team/
  state.json
  sessions/
    <sessionId>/
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

## 3. 核心组件

### 3.1 ProjectTeamStore

职责：
- 按项目根和会话 id 读写团队运行状态；
- 所有写操作原子化；
- 提供 archive / list / snapshot。

接口：

```ts
interface ProjectTeamStore {
  root(projectRoot: string): string
  loadSession(projectRoot: string, sessionId: string): Promise<SessionTeamState>
  saveSession(projectRoot: string, sessionId: string, state: SessionTeamState): Promise<void>
  listSessions(projectRoot: string): Promise<string[]>
  archiveSession(projectRoot: string, sessionId: string): Promise<void>
  snapshot(projectRoot: string): Promise<ProjectTeamSnapshot>
}
```

### 3.2 Mailbox

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

规则：
- 成员/队长通信只走 inbox；
- 投递前 claim，成功后 ack；
- 失败释放 claim，可重试；
- 已读消息不重复唤醒。

### 3.3 Scheduler 防重复派发

每个 taskId 增加：

```ts
interface DispatchGuard {
  dispatching: boolean
  dispatchedRunId?: string
  settled: boolean
}
```

派发条件：
1. task 必须是 WAITING/RUNNING 合法迁移；
2. 同一 taskId 当前没有未完成 run；
3. fork/spawn 快速 settle 后，只有状态仍可执行才允许再次派发；
4. 异常完成后先写终态，再重泵。

### 3.4 OnDutyController

职责：
- 决定主会话是否保持回合；
- 接收子代理事件并立即注入队长会话；
- 防抖/去重。

接口：

```ts
interface OnDutyController {
  refresh(sessionId: string): Promise<void>
  onMemberEvent(event: MemberEvent): Promise<void>
  onTurnStopping(sessionId: string): Promise<boolean>
  hasActiveWork(sessionId: string): Promise<boolean>
  hasUnread(sessionId: string): Promise<boolean>
}
```

行为：

```text
IDLE
  └─ 无任务、无未读 → 允许回合结束

ACTIVE
  ├─ 成员事件 → 立即注入队长 inbox
  ├─ 运行中任务 → turn-stopping 时注入 next-step
  └─ 全部完成且无未读 → 回到 IDLE
```

及时响应要求：
- 成员完成/失败：立即注入；
- 用户消息：最高优先；
- 子代理卡死：空闲超时自动终止并告警；
- 同一事件只注入一次。

## 4. 反思/记忆归属

```text
任务完成
  → Scheduler.onTaskSettled
  → ReflectionService
  → KnowledgeStore
  → ~/.dsh/knowledge/_agent/projects/<projectId>/...
```

禁止把反思写入：

```text
<projectRoot>/.dsh/weave/team/
```

原因：
- 团队可以删除/归档；
- 知识应该跨会话沉淀；
- 项目级状态只保存“运行中需要的东西”。

## 5. 团队页面稳定

- Web Team Tab 读取 `ProjectTeamStore.snapshot`；
- 状态快照带 `revision`；
- 客户端只在 revision 变化时刷新；
- 空闲无轮询；
- 页面启动先读本地状态，再异步刷新。

## 6. 子代理生命周期

### spawn

- 一次性任务执行；
- 任务完成后立即 settle；
- 不允许同一 taskId 重复 start。

### fork

- 可续会话；
- 使用 mailbox 投递后续任务；
- 任务未完成前不创建新 fork；
- fork settle 后如任务仍非终态，只重泵一次并记录告警。

### ACP/zcode

- 使用 sessionKey 复用会话；
- 同一 role/project/version 复用同一 session；
- 不因任务拆解而重复创建 ACP session。

## 7. 迁移策略

1. 旧 `core.db.team_bindings` 只读导入到 `<project>/.dsh/weave/team/state.json`；
2. 旧 `tasks.db` 任务可导出为 JSONL 存档；
3. 迁移完成后新逻辑只读写项目目录；
4. 旧数据不删除，保留回退能力。

## 8. 验收标准

- 团队页签稳定出现，不闪烁；
- 同一任务不会重复创建子代理；
- 成员完成后队长立即响应；
- 无任务时主会话可正常结束回合；
- 反思写入 `~/.dsh/knowledge`；
- 团队删除后反思仍存在；
- 多项目之间状态互不干扰。
