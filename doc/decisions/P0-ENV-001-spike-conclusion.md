# P0-ENV-001 Spike 结论：DSH 插件环境与 `ctx.subagents` 可用性

| 元信息 | 内容 |
| --- | --- |
| 任务 | P0-ENV-001（t2） |
| 执行人 | dev1（weave-phase0-squad） |
| 日期 | 2026-08-25 |
| 基线环境 | DSH `@deepseek-ai/dsh@0.1.1-rc.2`（`D:\Program Files\deepseek`），`@deepseek-ai/dsh-subagent@0.1.1-rc.2`（pip/npm 最新） |
| spike 命令 | `pnpm vitest run src/plugins/weave/__tests__/env-subagents-spike.test.ts` → **20/20 通过**（含真实运行时套件） |
| 环境检查 | `node scripts/env-check.mjs`（`pnpm env:check`） |

---

## 1. 结论（TL;DR）

1. **`ctx.subagents` 在 DSH 0.1.1-rc.2 上可用，且已通过真实代码路径验证**：在裸 cordis `Context`
   上构造 `SubagentRuntime`，`registerProvider → list() → start() → SubagentRun/result → dispose()`
   全链路走的是 `@deepseek-ai/dsh-subagent` 的真实实现（非 mock）。
2. **基线环境实际注册名只有 `spawn` / `fork`**（`dsh-subagent-spawn-in-process` /
   `-fork-in-process` 已安装，默认 `providerName` 即 `spawn`/`fork`；standard preset 中
   `tool-subagent` / `tool-subagent-fork` 两行启用）。`codex` / `claude-code` / `acp(zcode)`
   **未安装**：npm 最新版均为 `0.0.1-rc.1`（低于基线 `0.1.1-rc.2`），preset 中对应工具行
   `disabled: true`（注释：Production dsh does not install these optional providers）。
   → 评审 BLK-2 成立：**"四类执行器"在基线环境只能实证 spawn/fork**，需按评审方案 A/B 决策。
3. **API 形态与文档假设**：文档（SDD/TDD/架构）中的
   `await ctx.subagents.list()`（实为同步 `list(): string[]`）、`SubagentRequest { prompt: string }`
   （实为 `prompt: ContentBlock[]`）、`SubagentTaskOutput { stdout/stderr/summary/duration_ms }`
   （真实返回 `SubagentRun { id, localAgent, result: Promise<SubagentResult>, dispose() }`，
   `SubagentResult { output: ContentBlock[], structured?, diagnostic?, stopReason }`）**均需按
   真实 API 修订**（评审 E2-E4 / BLK-1）。
4. **`permission_denied` 无结构化承载**：`stopReason` 枚举仅 `completed / aborted / error /
   max-tokens / refusal`；非交互模式下的权限拒绝发生在子代理内部，向父进程表现为
   `stopReason: 'refusal' | 'error'` 或输出/诊断文本，**没有** `permission_denied` 枚举与
   `execution_failed`/`timeout`/`parse_failed`/`crash`/`unavailable` 对应物。错误映射表必须重写
   （建议：`aborted→CANCELLED`；`error|max-tokens|refusal→FAILED`；`unavailable` 改由
   `NO_PROVIDER` 前置校验表达；P0 删除/降级 `permission_denied` 的强制断言，改为输出/诊断
   文本启发式识别——评审 BLK-1 建议）。
5. **`ctx.subagents` 是服务注册表的封装入口**（实证新增）：`ctx.subagents !== runtime 实例`，
   但 `providers` 同源、`instanceof SubagentRuntime` 为真、公开方法一致——生产插件经
   `ctx.subagents` 消费即可，无需关心身份。

---

## 2. 实证：真实 API 快照（读 @deepseek-ai/dsh-subagent@0.1.1-rc.2 类型与源码）

### 2.1 `SubagentRuntime`（注册在 `Context.subagents`）

| 成员 | 签名 | 说明 |
| --- | --- | --- |
| `list()` | `(): string[]` | **同步**，按注册顺序返回 provider 名 |
| `start(name, request)` | `(string, SubagentStartRequest): Promise<SubagentRun>` | 能力校验前置：`NO_PROVIDER` → `UNSUPPORTED_CAPABILITY` → `maxDepth` → `outputSchema` 校验 → 快照 descriptor → `provider.start` |
| `registerProvider(provider)` | `(SubagentProvider): () => void` | `ctx.effect` 作用域注册；重复名抛 `DUPLICATE_PROVIDER`；disposer 触发 `provider-removed` |
| `getProvider(name)` | `(string): SubagentProvider?` | 同步查找 |
| `startContinuable` / `followup` / `interrupt` / `reportFrom` / `listChildren` / `listDescendants` 等 | — | 可续子代理链路（Weave P0 主链路用 `start` 一次性即可，续接留待持续对话场景） |

### 2.2 `SubagentStartRequest`

```typescript
{
  label?: string;
  prompt: ContentBlock[];       // [{ type: 'text', text: string }] 等 —— 不是 string！
  parent: Agent;                // 必填；同进程 provider 从父会话派生 workspace/lineage/depth
  signal: AbortSignal;          // 必填；发布前 abort → start() 拒绝；发布后 abort → 取消剩余 turn 工作
  agentOptions?: AgentOptions;
  outputSchema?: ObjectJsonSchema;   // 需要 outputSchema 能力
  maxDepth?: number;                 // 需要 depthLimit 能力
  toolFilter?: ToolRestriction;      // 需要 toolFilter 能力
  persona?: string;                  // 需要 persona 能力
}
```

### 2.3 `SubagentRun` / `SubagentResult`

```typescript
SubagentRun = {
  id: SessionId;
  localAgent?: Agent;                       // 远端 provider 为 undefined
  result: Promise<SubagentResult>;          // 子代理失败不 reject（stopReason='error'）
  dispose(): Promise<void>;                 // 幂等；取消剩余工作并沉淀
}
SubagentResult = {
  output: ContentBlock[];                   // 最后一条非空 assistant 消息
  structured?: unknown;
  diagnostic?: string;                      // 非 completed 的 provider 故障描述（≤4096B）
  stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal';
}
```

### 2.4 事件（scoped dispatch 以父为 key）

- `subagent/provider-added`（ctx.emit，未限定作用域）— `SubagentProvider`
- `subagent/provider-removed`（scoped emit）— `name: string`
- `subagent/start` / `subagent/end` — `SubagentRunInfo` / `SubagentRunEndInfo`（成对，`runId` 关联）

---

## 3. 实证：真实代码路径的行为（Suite B 断言内容）

| # | 断言 | 结果 |
| --- | --- | --- |
| B1 | `new Context()` + `new SubagentRuntime(ctx)` 可构造，`ctx.subagents` 暴露 `list/start/getProvider/registerProvider` | ✅ |
| B2 | 注册前 `list() === []` 且**同步**（非 Promise） | ✅ |
| B3 | `registerProvider` → `list() = [name]`、`getProvider` 返回同一对象、`provider-added` 事件触发；disposer → 移除 + `provider-removed` | ✅ |
| B4 | `start('spawn', {prompt:[ContentBlock], parent, signal})` → 返回 `SubagentRun`，`result` 以 `completed` 完成，`dispose()` 幂等；`subagent/start`+`subagent/end` 成对 | ✅ |
| B5 | `start('nope')` → `SubagentError{ code:'NO_PROVIDER' }` | ✅ |
| B6 | persona 能力缺失时 `start(...)` → `SubagentError{ code:'UNSUPPORTED_CAPABILITY' }`（fail loud） | ✅ |

> 局限说明：本 spike 的 `parent` 使用占位（未挂真实 Agent 会话）；真实 `start('spawn')`
> 需要活动 Agent 作为 parent（同进程 provider 从父会话派生子代深度/工作区），该路径无法在
> vitest 进程内完整复现——已由 preset + `dsh-tool-subagent` 源码用法 + **真实会话冒烟**（见 §3.1）佐证。

### 3.1 真实会话冒烟（本任务执行期间，运行中的 DSH 实例内）

在 DSH Web 会话内通过模型面向的 `subagent` 工具（即 `tool-subagent`，preset 配置
`provider: spawn`）发起一次最小委托：

- 子代理 prompt：「请只回复一行：ENV-SPIKE-OK」
- 结果：子代理**正常返回** `ENV-SPIKE-OK`（subagent c6f36519-295a-422a-8fae-131b7fd3685d）
- 结论：**真实环境中 `ctx.subagents.start('spawn', …)` 端到端可返回**（架构 15.1 #1 通过），
  `fork` 同类（同进程 provider，仅继承父上下文的差异，P0-DELEG-007 完成时再冒烟一次）。

---

## 4. 环境事实（`scripts/env-check.mjs` 输出）

| 事实 | 值 |
| --- | --- |
| DSH 版本 | `0.1.1-rc.2` |
| dsh-subagent | `0.1.1-rc.2`（npm 最新） |
| spawn-in-process / fork-in-process | 已安装 | 
| codex | 未安装；npm 最新 `0.0.1-rc.1`；preset `disabled: true` |
| claude-code | 未安装；npm 最新 `0.0.1-rc.1`；preset `disabled: true` |
| acp | 未安装；（registry 名示例 `zcode`） |

---

## 5. 对下游任务的约束（回写建议）

1. **P0-REG-002（ExecutorRegistry）**：`ctx.subagents.list()` 同步调用（勿 await）；`ExecutorInfo`
   的分类输入是 provider 名：`spawn|fork → dsh_subagent`；`codex → codex`；`claude-code → claude_code`；
   其余 `acp`。`capabilities` 字段应以真实 `SubagentCapabilities`
   （outputSchema/depthLimit/toolFilter/persona）为准或删除虚构常量（评审 E5/LO-8）。
2. **P0-DELEG-007（DelegationService）**：`ctx.subagents.start(executor, { prompt: ContentBlock[],
   parent, signal })`；`buildPrompt` 产物须包装为 `ContentBlock[]`；结果映射重写为
   `stopReason → 任务终态`；`SubagentTaskOutput` 改为 `{ id, output, diagnostic?, stopReason,
   structured? }`（时长由 Weave 自行计时）。
3. **P0-TEAM-003（team.yaml 校验）**：执行器存在性校验 = `registry.get(executor)`；缺失错误码
   `executor_unavailable`（与 `NO_PROVIDER` 语义对齐）。
4. **CLI/MCP 执行器列表**：直接消费 `registry.list()`，无需真实 start。

---

## 6. 交付物清单

| 文件 | 说明 |
| --- | --- |
| `src/plugins/weave/__tests__/env-subagents-spike.test.ts` | spike 测试（Suite A mock 合约 / Suite B 真实运行时 / Suite C 快照一致性），`pnpm vitest run` 20/20 绿 |
| `src/plugins/weave/__tests__/fixtures/mock-subagents.ts` | API 验证夹具：真实 API 快照类型 + `MockSubagentsContext`（文档 5.3；含 start/abort/settle/manualCompletion） |
| `scripts/env-check.mjs` | 环境检查脚本（DSH 版本、provider 包安装状态、preset 工具行、结论；`node scripts/env-check.mjs`） |
| 真实会话冒烟 | `subagent`（spawn）最小委托返回 ENV-SPIKE-OK —— 架构 15.1 #1 实证通过 |
| 本文件 | 可用性结论 |

**复现**：

```bash
pnpm install            # devDeps: vitest + @deepseek-ai/dsh-subagent@0.1.1-rc.2
pnpm vitest run src/plugins/weave/__tests__/env-subagents-spike.test.ts
node scripts/env-check.mjs
```
