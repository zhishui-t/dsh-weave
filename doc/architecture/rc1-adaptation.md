# DSH 0.1.2-rc.1 适配面审计（rc1-adaptation）

- 基线：宿主 **0.1.1-rc.2**（当前在用，暂不升级）；目标：**0.1.2-rc.1** 双兼容。
- 审计范围：`src/`、`test/`（抽查）、`package.json`、`cordis.patch.yml`。
- 审计方法：关键词 grep（`report`、`send_message`、`.events` / `SessionEvent`、
  `apiproxy`、`ChatNodeDataMap`、`sqlite`、`surface`、`@deepseek-ai/*`）+ 逐文件人工判定。
- 兼容总原则：**特性探测**——运行时探测新 API 存在则走新路径，否则走旧路径；
  服务端零硬依赖宿主新 API，保证 0.1.1-rc.2 与 0.1.2-rc.1 双宿主可加载。
- 审计基线 commit：master `f56228f`（restore own-teamengine merge）。

## 0. 总览

| 点 | 变更 | 命中 | 风险 | 策略 |
| --- | --- | --- | --- | --- |
| a | 子代理单向 `report` 工具 → `send_message` | 零直接引用；间接面 1 处 | 低 | 不改码；随 dsh-agent/dsh-subagent 升级联动验证 |
| b | `Session.events` → 按需 `seq`/`eventAt()`/`snapshotEvents()` | **2 文件 5 处直接读** | 高 | 读面收敛为适配函数 + 特性探测 |
| c | 旧 APIProxy 移除 | 零引用 | 无 | 不改 |
| d | 宿主可选 SQLite session 后端移除 | 零引用（自研 persistence 独立） | 无 | 不改 |
| e | 会话视图工程拆分 → client 注入面 | client 2 槽位 + 服务端 3 处 surface/append/inject | 中 | 槽位名/服务名保持契约；已全部特性探测或守卫 |

## 1. 逐点详述

### a) 子代理单向 report 工具 → send_message

**grep 结论**：`src/` 中 `'report'` 字符串字面量、`send_message`、`sendMessage` 均**零命中**。
所有 `\breport\b` 命中皆为内部变量名（`negotiation.report`、`RecoveryReport`、`run.intentApplied`），
与 DSH 子代理 report 工具无关；prompt 文本中的「回灌/汇报」均为通知性中文叙述，不指示模型调用某工具。

**间接耦合面（1 处）**：

| 位置 | 当前用法 | 影响 |
| --- | --- | --- |
| `src/plugins/weave/executors/dsh-subagent-executor-provider.ts:1-2` | `import { foldConsumedWork, installModelSelection } from '@deepseek-ai/dsh-agent'`；`import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'` | 子代理产出回收走**通用事件折叠**：`foldConsumedWork(events)`（turn/step/inbox 词汇，已核实 dsh-agent 0.1.1-rc.2 `lib/types/consumed-work.js` 不按工具名识别 report）+ `finalAssistantOutput(events)`（读 assistant 消息块）。若 0.1.2 子代理改用 `send_message` 回灌，事件流里工具名变化由**这两个库的 0.1.2 版本内部消化**，weave 不按名字耦合 |

另有一处消息语义面：`dsh-subagent-executor-provider.ts:270-277` `followup(..., { source: { kind: 'coordinator', form: 'relay', senderSessionId } })`——relay 语义正是 0.1.2 send_message 正式化的方向；调用形状由宿主 `subagents.followup` 承接，weave 侧无工具名硬编码。

**策略**：不改码。宿主升级时联动升级 devDeps（见 §3 演练清单），跑
`pnpm vitest run test/unit/plugins/weave/`（executor/session 家族）回归。
特性探测不适用于本点——weave 从不主动调用该工具。

**实施核验（t3，2026-09-05）**：按本节裁定执行为「不改码」，实施时点独立复核证据——
`src/` 对 `send_message`/`sendMessage` 零命中；适配任务点名的三文件均无 report 工具按名引用：
`feedback-router.ts` 实为**用户反馈**保温期路由（accept/revise/cancel，与子代理回灌域不同、零交集）；
`session-delegation.ts` / `delegation-service.ts` 的「回灌」仅存在于注释与通知性叙述（无工具名指令）；
任务描述模板（`delegation-service.ts` `buildPromptParts`）与 `EXECUTION_DISCIPLINE` 只要求
文本产出 + WEAVE_KNOWLEDGE 块，出现的工具名仅 weave 自有 `weave_knowledge_search` /
`knowledge_search`；产出回收侧 `foldConsumedWork`（dsh-agent 0.1.1-rc.2 `consumed-work.js`）
无 `'report'`/`'send_message'` 字符串耦合。send_message 双分支特性探测按 §2 裁定不落地
（weave 无该工具调用点，预接即死代码开测试账）；0.1.2 升级日随 §3 演练第 1/3 步联动验证。

### b) Session.events → 按需 API（seq / eventAt() / snapshotEvents()）

**直接命中（唯一高风险面）**，共 2 文件；`eventAt`/`snapshotEvents` 在 src/ 中**零使用**（尚无新路径代码）：

| # | 位置 | 当前用法 | 用途 |
| --- | --- | --- | --- |
| 1 | `src/plugins/weave/executors/dsh-subagent-executor-provider.ts:67` | `ChildAgentLike.session?: { events?: Array<...> }` | 宿主 Session 事件数组的本地视面类型 |
| 2 | 同上 `:114` | `child.session?.events?.slice(boundary)` → `foldConsumedWork(own)` + `finalAssistantOutput(own)` | one-shot/continuable 共用：按边界切出本轮事件并折叠产出与 stopReason |
| 3 | 同上 `:262` | `boundary = initialChild.session?.events?.length ?? 0` | 新建 continuable 子代理的事件边界 |
| 4 | 同上 `:269` | `boundary = existingChild.session?.events?.length ?? 0` | 复用子代理 followup 前的事件边界 |
| 5 | `src/plugins/weave/scheduling/session-delegation.ts:92-95`（类型 `:45-69`） | `hasPendingToolCall`：遍历 `session.events` 建 `bySeq` Map，与 `session.surface?.nodes`（seq 数组）交叉，判定 tool-call 未闭合窗口 | 会话 notice 安全写入时机的判定 |

间接调用方（同一读面，随 #5 一并适配）：`core/team-runtime.ts:79`、`host/host-wiring.ts:749`。
`session-delegation.ts:120-124` 的 `session.append('user/message', data, { surfaceOp: 'append' })`
依赖 surface 投影，归入点 (e) 一并看护。

**确认为误命中（weave 自有状态，与宿主 Session.events 无关，不改）**：

- `scheduling/delegation-service.ts:373/380/401-403/448-450/769` —— `run.events` 为 DelegationRun 自有环形缓冲；
- `host/rpc.ts:355/382/394` —— `executorRuns` 服务自有快照；
- `acp/acp-session-provider.ts:573/690/704/823` —— `controller.events` 自有缓冲；
- `client/index.ts:1027/4877/5353/5383` —— RPC payload（audit/list、executor/run-events）；
- `host/settings-store.ts:90` —— settings JSON；
- `scheduling/session-delegation.ts:95` 中 `event.seq` 读的是**事件对象上的 seq 字段**（宿主事件本就携带 seq），与按需 API 无冲突。

**兼容策略（特性探测）**：

1. 新增窄适配函数（建议落点 `executors/session-events-adapter.ts`，两处消费方共用）：

   ```ts
   /** 特性探测：0.1.2 snapshotEvents() 优先，0.1.1 .events 数组兜底；双宿主等价读面。 */
   function readSessionEvents(session: unknown): readonly EventLike[] | undefined {
     const s = session as { snapshotEvents?: () => readonly EventLike[]; events?: readonly EventLike[] }
     if (typeof s.snapshotEvents === 'function') return s.snapshotEvents()
     return s.events
   }
   /** 边界=事件数：新 API 无数组长度时用末事件 seq+1（seq 单调），旧 API 用 .length。 */
   ```

2. 边界语义：0.1.1 用 `events.length`；0.1.2 用 `seq` 切片（`eventAt(seq)`/`snapshotEvents(afterSeq)`）。
   `hasPendingToolCall` 已按 `event.seq` 建索引，天然兼容 seq 寻址，仅需把「取全量数组」换成适配函数。
3. 消费库输入不变：`foldConsumedWork`/`finalAssistantOutput` 仍吃 `readonly SessionEvent[]`——
   适配函数吐数组即可，0.1.2 下由 `snapshotEvents()` 物化。
4. 回归锚点：`dsh-subagent-executor-provider` 现有测试替身全部走 `.events` 形状（旧路径），
   适配函数落地后补 1 例「session 仅提供 snapshotEvents」的替身用例锁定新路径。

**实施核验（t2，2026-09-05）**：本节策略已落地——适配器 `executors/session-events-adapter.ts`
三件套（`readSessionEvents` / `readSessionEventBoundary` / `sliceSessionEvents`：snapshotEvents()
优先、`.events` 数组兜底；boundary 与 slice 成对且落在同一探测分支，旧路径逐字节保持下标语义，
新路径单调 seq 寻址），替换上表全部 5 处直接读（executor 侧 4 处：
`dsh-subagent-executor-provider.ts` 的 ChildAgentLike 视面 / readChildResult 切片 / 两处
continuable 边界捕获；delegation 侧 1 处：`session-delegation.ts` hasPendingToolCall）。
测试锚定：适配器单测 9 例（两分支 + null/非数组返回/缺 seq/空物化/后缀窗口病态输入），
executor 侧补「仅 snapshotEvents」替身端到端 1 例，delegation 侧补 pending/closed 2 例；
既有 `.events` 替身原样经旧路径全绿（旧宿主行为不变）。两分支各代宿主均有真实路径
（0.1.1 常驻数组 → 兜底分支；0.1.2 按需 API → snapshotEvents 分支），新路径行为由替身
锁定、升级日即活，非死代码。

### c) 旧 APIProxy 移除

**grep 结论**：`apiproxy`（大小写不敏感）在 `src/`、`test/`、`package.json` **零命中**。
weave 与宿主的通信面是 `ctx.inject([...])` 服务名 + `connection.rpc.call('/dsh-weave', ...)`（client 侧，
`src/client/index.ts:6260` 附近），从未引用 APIProxy。

**策略**：不改。

### d) 宿主可选 SQLite session 后端移除

**grep 结论**：`sqlite` 命中全部为 weave **自研 persistence**：
`persistence/weave-database.ts:1`（`node:sqlite` 内置 `DatabaseSync`，Node ≥22 自带，不依赖宿主）、
`persistence/persistence.ts:18`、`persistence/single-writer-queue.ts:2`、`team/migration.ts:4`、
`index.ts:25`（注释）。无 `better-sqlite3`、无宿主 session-store/backend 导入（`dependencies` 中亦无 sqlite 相关包）。
宿主移除其可选 SQLite session 后端不影响本插件：weave 的会话持久化是
`~/.dsh/weave/acp-session-index.json`（JSON 文件）+ 自管 5 库 SQLite，二者与宿主会话存储无交集。

**策略**：不改。验收此项即本节零依赖确认。

### e) 会话视图工程拆分 → client 注入面

`ChatNodeDataMap`：`src/`、`test/` **零命中**，无此类型耦合。

client 侧注入面（`src/client/index.ts:6235-6300`，单文件 bundle，DSH ModuleLoader 装载）：

| 位置 | 当前用法 | 拆分风险 |
| --- | --- | --- |
| `:6235-6241` | `window.__ModuleLoader__.load({ id, factory })`；缺失即 throw（刻意 fail-fast） | 装载器契约变化才会破坏；与视图拆分无直接交集 |
| `:6252-6258` | `ctx.get('sessions')` as `SessionNavigator`（try/catch 守卫，可缺席降级） | 已守卫；服务改名时静默降级为「不跳转子会话」 |
| `:6270-6282` | `ctx.slots.inject('sidebar.footer.action', ...)`（order 80） | 槽位名契约 |
| `:6284-6296` | `ctx.slots.inject('conversation.view', ...)`（order 70，label「Weave 团队」）——**会话团队页签** | **会话视图拆分的最直接受力点**：槽位名或挂载时机变化即失效 |
| `:6303` | `module.exports.inject = ['slots', 'connection', 'sessions']` | 服务名清单契约 |

服务端 surface/append 面（视图拆分的写侧投影）：

| 位置 | 当前用法 |
| --- | --- |
| `scheduling/session-delegation.ts:119-125` | `session.append('user/message', msg, { surfaceOp: 'append' })`——notice 落 durable log 并上表面 |
| `session-delegation.ts:67-68` | `surface?.nodes: readonly number[]` + `events` 最小视面（缺失时保守降级） |
| `core/team-runtime.ts:79-84` | `hasPendingToolCall(session)` 命中且 `agent.inject` 存在 → 走 inbox 注入（特性探测已内建：`typeof agent?.inject === 'function'`） |
| `host/host-wiring.ts:749-752` | 同上模式 |
| `index.ts:181-183` | `typeof agent?.inject === 'function'` 特性探测后 `agent.inject(message)` |

**兼容策略**：

1. 槽位名 `conversation.view` / `sidebar.footer.action` 是插件-宿主契约：视图拆分若改名，靠
   宿主 changelog 驱动一次性跟进（无法运行时探测「槽位不存在」与「挂载失败」的差异——
   `ctx.slots.inject` 不抛错）。现不加防御性代码，理由见 §2。
2. `ctx.get('sessions')` 已 try/catch 降级；`agent.inject` 已特性探测——两处天然双兼容，不改。
3. `surfaceOp` / `surface.nodes`：宿主已声明 `Session.events` 向前兼容，surface 投影随视图拆分
   若变更，影响面集中在 `hasPendingToolCall`（误判时 notice 走 inbox 注入兜底，已有降级路径，
   最坏效果是 notice 可见时机后移，不丢通知）。

## 2. 不改清单与理由

| 项 | 理由 |
| --- | --- |
| APIProxy（点 c） | 零引用，无动作可做 |
| 宿主 SQLite 后端（点 d） | weave 持久化全自研（`node:sqlite` 内置 + JSON 索引），与宿主后端零交集 |
| report 工具改 send_message（点 a） | weave 不按名引用该工具；回收逻辑吃通用事件流，工具名变化由 dsh-agent/dsh-subagent 库内消化 |
| client 注入防御性 try/catch 加固（点 e） | `ctx.get('sessions')` 已守卫、`agent.inject` 已探测、`moduleLoader` 缺失 throw 是刻意的 fail-fast（静默加载失败比崩溃更难排查） |
| peerDependencies 立即放宽 | ~~见 §3：host 暂不升级，pin 维持 0.1.1-rc.2 即为当前正确约束~~ **t4 裁定翻转（2026-09-05，队长令）**：已放宽为 `^0.1.1-rc.2 \|\| ^0.1.2-rc.1` 双接受——lockfile 解析仍落 0.1.1-rc.2（构件不变），仅消除升级日安装校验硬冲突；原担忧（0.1.1 环境误装 0.1.2 构件）由「lockfile 不动 + devDeps 仍 pin 0.1.1-rc.2」兜住 |
| 新 API（snapshotEvents/eventAt）预接代码（点 b） | ~~宿主未升级，0.1.1 下新路径永远探测失败；提前写等于给死代码开测试账。落地时机在升级演练内，随适配函数一并进~~ **t2 裁定翻转（2026-09-05，队长令）**：点 b 适配函数已提前落地（两分支特性探测 + 替身锁定新路径行为，见 §1.b 实施核验）——「死代码测试账」的顾虑由「替身使新路径恒有回归锚定」化解；提前落地的成本可控，升级演练第 2 步工作量减半 |

## 3. 宿主升级日演练清单（0.1.1-rc.2 → 0.1.2-rc.1）

按序执行，每步可回退：

1. **package.json**：`peerDependencies["@deepseek-ai/dsh-agent"]` 由精确 `0.1.1-rc.2` 放宽为
   区间（如 `>=0.1.1-rc.2 <0.2`）；devDeps 三件套（dsh-agent/dsh-commands/dsh-subagent）升到 0.1.2-rc.1，
   装包后跑 `pnpm typecheck` 暴露类型层破坏（`ChildAgentLike`、`Parameters<typeof foldConsumedWork>` 均为类型面哨兵）。
   ✅ **声明放宽半步已由 t4 提前完成**（dev+peer 五处统一 `^0.1.1-rc.2 || ^0.1.2-rc.1`，lockfile specifier 同步，semver 双版本可解析 + `--frozen-lockfile` 过）；**剩余**：升级日把 devDeps 实际装到 0.1.2-rc.1 后跑 typecheck。
2. **点 b 落地**：新增 `readSessionEvents` 适配函数（特性探测 snapshotEvents→events 兜底），
   替换 §1.b 表中 5 处直接读；补「仅 snapshotEvents」替身用例。
   ✅ **已由 t2 提前完成**（适配器三件套 + 5 处替换 + 两分支测试锚定，详见 §1.b 实施核验；
   devDeps 仍为 0.1.1-rc.2，本步剩余仅升级日真宿主冒烟）。
3. **回归**：`pnpm vitest run`（全量）+ `pnpm build` + `pnpm test:e2e:harness`（stub RPC，不依赖真实宿主版本）。
4. **真宿主冒烟**：live E2E（`pnpm test:e2e:live`）重点验：会话团队页签挂载（点 e 槽位）、
   委托执行器产出回收（点 a/b）、notice 落面（点 e surface）。
5. 若槽位名变更：一次性改 `src/client/index.ts:6285/6273` 两处 + `pnpm build`（单文件 bundle 约束不变）。

## 4. 版本 pin 现状（t4 放宽后快照，2026-09-05）

```jsonc
// package.json（t4 依赖放宽后）
"dependencies": {
  "@deepseek-ai/cordis": "^4.0.1",          // Cordis fork，宿主运行时无关，4.x 线与宿主 0.1.x 无关，不动
  "zcode-acp-server": "0.11.9"              // 桥，与 DSH 版本解耦
},
"devDependencies": {
  "@deepseek-ai/dsh-agent": "^0.1.1-rc.2 || ^0.1.2-rc.1",   // src 运行时 import（宿主装载时解析）
  "@deepseek-ai/dsh-commands": "^0.1.1-rc.2 || ^0.1.2-rc.1",
  "@deepseek-ai/dsh-subagent": "^0.1.1-rc.2 || ^0.1.2-rc.1" // src 运行时 import
},
"peerDependencies": {
  "@agentclientprotocol/sdk": ">=0.25.1 <2",
  "@deepseek-ai/dsh-agent": "^0.1.1-rc.2 || ^0.1.2-rc.1",   // 原精确 pin 硬冲突点已消除（t4）
  "@deepseek-ai/dsh-commands": "^0.1.1-rc.2 || ^0.1.2-rc.1"
},
"dsh": {
  "client": { "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-ui-slots"], "platform": "web" }
}
```

注：`dsh.client.inject` 两模块名由宿主 web bundle 提供（点 e 装载面），改名属宿主 breaking，
随演练第 4 步冒烟覆盖。

### 实施核验（t4，2026-09-05）

- **a) 依赖声明双版本放宽**：semver 预发布规则下 `^0.1.1-rc.2` 不匹配 `0.1.2-rc.1`（无同
  `[0,1,2]` 元组比较器），故统一用 OR 范围 `^0.1.1-rc.2 || ^0.1.2-rc.1`（lockfile 内 zod
  `^3.25.0 || ^4.0.0` 同款先例）。验证：semver 矩阵 7/7 PASS（`0.1.1-rc.2`✓ `0.1.2-rc.1`✓
  `0.1.0-rc.9`✗ `0.2.0-rc.1`✗）；lockfile specifier 三处同步（resolved 仍 `0.1.1-rc.2`，
  version/peer hash 零变化）；`pnpm install --frozen-lockfile` 只读校验通过
  （Already up to date，零安装）。
- **b) apiproxy 残留**：全仓复 grep（src/test/scripts/doc/e2e/examples/根配置），命中仅本文档
  自述（§0/§1.c），代码零残留，无需清理。
- **c) dsh persistence-sqlite 零依赖**：`persistence-sqlite`/`better-sqlite3`/`dsh-persistence`/
  `SessionStore` 全仓零命中；`WeaveDatabase` 仅依赖 `node:sqlite` 内置（DatabaseSync）+
  内部 SingleWriterQueue，自研不变。
- **d) typecheck**：主树因并行在途编辑（`team/mailbox.ts` + `state/types.ts`，`MailboxMessage`
  新增必填 `to` 字段的中间态）瞬时报 TS2741；以隔离 worktree（HEAD `0174ebd` + 本轮两个文件）
  证得本轮改动 typecheck 干净（exit 0）——并行工作树归因方法，主树待该编辑窗口关闭后自愈转绿。
