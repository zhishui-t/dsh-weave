# Weave 分层重构与自有团队引擎接回方案

> 分支：`restore/own-team-engine`
> 基线：`master_weave_0829`
> 目标：接回自有团队引擎，迁移代码图谱，按“Weave 总览在上、实现层在下”重构架构。

## 1. 背景与目标

1. 当前 `dsh-agent-teams` fork 存在卡死、子代理传输错配、回合不结束等问题。
2. 需要接回 Weave 自有的团队引擎：`delegation-service`、`planner`、`scheduler` 等。
3. 当前代码图谱能力需要迁移到旧基线，并保留 Web Console 代码图谱页面能力。
4. 需要重构模块边界，让 Weave 顶层只做总览与装配，实现层按职责独立。

## 2. 当前基线与差距

### 2.1 旧基线已有

- 自有团队引擎：
  - `delegation-service.ts`
  - `scheduler.ts`
  - `planner.ts`
  - `task-status-notifier.ts`
  - `session-tracker.ts`
  - `captain-turn-guard.ts`
- 基础代码图谱：
  - `graph/graph-service.ts`
  - `graph/knowledge-graph.ts`
  - `rpc.ts`
  - `web/query-service.ts`
- Web 客户端与 Dashboard。

### 2.2 旧基线缺少

- `code/projects`、`code/dirs`、`code/status` RPC 端点。
- `GraphService.sourceDir` 支持。
- `/weave code build` 命令。
- Web 代码图谱页面中的项目下拉与文件夹选择。
- 清晰的分层边界。

## 3. 目标架构

```text
┌─────────────────────────────────────────────────────────┐
│                     Weave 总览层                         │
│  src/plugins/weave/index.ts                             │
│  职责：生命周期、服务装配、命令/RPC/客户端注册            │
└──────────────────────────┬──────────────────────────────┘
                           │ 只依赖接口
┌──────────────────────────▼──────────────────────────────┐
│                   团队引擎层                             │
│  delegation-service / planner / scheduler                │
│  task-status-notifier / session-tracker / turn-guard     │
│  对外接口：plan/start/cancel/retry/status/settle          │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                 执行器抽象层                             │
│  executor-registry / executor-provider                   │
│  实现：spawn / fork / zcode / ACP                        │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                   能力实现层                             │
│  code-graph / knowledge-graph / reflection               │
│  obsidian / document / audit / persistence               │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                  呈现/接入层                             │
│  rpc.ts / web console / src/client/index.ts              │
└─────────────────────────────────────────────────────────┘
```

### 3.1 依赖规则

1. 上层可以依赖下层接口，禁止反向依赖。
2. 能力层不得依赖团队引擎和 UI 层。
3. 执行器层不得依赖团队引擎。
4. Weave 总览层只做装配，不写业务逻辑。
5. 跨层调用通过接口或 Cordis service，禁止跨层直接 import 具体实现。

## 4. 模块设计

### 4.1 Weave 总览层

文件：

- `src/plugins/weave/index.ts`

职责：

- 创建执行器注册表
- 创建团队引擎服务
- 创建代码图谱/知识图谱/反思等能力
- 注册 `/weave` 命令
- 注册 RPC 和 Web 客户端入口

### 4.2 团队引擎层

恢复文件：

- `delegation-service.ts`
- `planner.ts`
- `scheduler.ts`
- `task-status-notifier.ts`
- `session-tracker.ts`
- `captain-turn-guard.ts`

对外接口：

```ts
interface TeamEngine {
  plan(input: PlanInput): Promise<PlanResult>
  start(plan: PlanResult): Promise<void>
  cancel(taskId: string): Promise<void>
  retry(taskId: string): Promise<void>
  status(): Promise<TeamStatus>
  onTaskSettled(handler: TaskSettledHandler): void
}
```

### 4.3 执行器抽象层

文件：

- `executor-registry.ts`
- `executors/executor-provider.ts`
- 实现：`spawn` / `fork` / `zcode` / `acp`

接口：

```ts
interface ExecutorProvider {
  id: string
  capabilities: ExecutorCapabilities
  start(request: ExecutorStartRequest): Promise<ExecutorRun>
  describeSession(cwd?: string): Promise<ExecutorSessionConfig | undefined>
}
```

### 4.4 能力实现层

代码图谱文件：

- `graph/graph-service.ts`
- `graph/knowledge-graph.ts`

代码图谱接口：

```ts
interface GraphService {
  projectRoot: string
  sourceDir?: string
  build(): Promise<{ graphPath: string; flowsPath: string }>
  graphSummary(): Promise<GraphSummary>
  shortestPath(source: string, target: string): Promise<string>
  explain(node: string): Promise<string>
  affected(paths: string[]): Promise<AffectedFlowsResult>
  listFlows(): Promise<GraphFlow[]>
}
```

### 4.5 呈现/接入层

- 保留旧团队引擎所需的 `task/*`、`run/events` 等端点。
- 增加新代码图端点。
- Web 客户端只调用 `/dsh-weave` RPC。

## 5. 代码图谱迁移详细设计

### 5.1 GraphService.sourceDir

```ts
class GraphService {
  constructor(options: { projectRoot: string; sourceDir?: string }) {}

  async build(): Promise<{ graphPath: string; flowsPath: string }> {
    const sourceDir = this.sourceDir ?? 'src'
    await this.run(['extract', sourceDir, '--out', this.projectRoot, '--no-description', '--no-label'])
    await this.run(['flows', 'build', '--graph', this.graphPath])
  }
}
```

### 5.2 项目发现与目录选择

```ts
function listGraphProjects(): Array<{
  root: string
  sourceDir: string
  hasGraph: boolean
  hasFlows: boolean
  current: boolean
}>

function listDirectories(inputPath?: string): {
  path: string
  parent?: string
  dirs: string[]
}
```

### 5.3 新增 RPC 端点

| 端点 | 输入 | 输出 |
|---|---|---|
| `code/projects` | 无 | 项目列表 |
| `code/dirs` | `path?` | 目录选择数据 |
| `code/status` | `projectRoot?` | 图谱状态 |
| `code/build` | `projectRoot?`, `sourceDir?` | 构建结果 |

### 5.4 命令

```text
/weave code build [projectRoot] [sourceDir]
```

## 6. 任务规划

### T1 基线确认

- 确认 `restore/own-team-engine` 分支可构建。
- 确认旧团队引擎文件完整。
- 验收：`pnpm typecheck` 通过。

### T2 代码图谱能力迁移

- 改造 `graph/graph-service.ts`。
- 增加 `sourceDir` 支持。
- 增加项目发现与目录列表。
- 验收：可构建图谱、单元测试通过。

### T3 旧 RPC 扩展

- 在 `rpc.ts` / `web/query-service.ts` 增加：
  - `code/projects`
  - `code/dirs`
  - `code/status`
- 验收：HTTP 调用返回正确结构。

### T4 命令接入

- 移植 `graph-tool.ts`。
- 注册 `/weave code build`。
- 验收：命令可触发构建。

### T5 Web 客户端代码图谱页面

- 更新 `src/client/index.ts`。
- 增加项目下拉、文件夹选择、状态展示。
- 验收：Web 页面可操作。

### T6 架构优化

- 梳理 Weave 顶层装配。
- 明确团队引擎、执行器、能力、呈现层接口。
- 删除越层依赖与重复实现。
- 验收：依赖方向检查、typecheck。

### T7 集成验证

- 构建 Web 客户端。
- 启动 DSH Web。
- 验证团队引擎与代码图谱页面。
- 验收：完整走通一次。

## 7. 风险与回退

1. 旧分支与当前分支依赖差异较大，移植时禁止一次性大改。
2. 每个任务单独提交，失败时可直接 revert 该提交。
3. `subprojects/` 当前为未跟踪目录，不纳入本次重构提交，避免误提交子模块。
4. 不删除旧团队引擎文件，直到新分层验证通过。
