# Review Report — Round 4（P1 增量下发 / 实时回灌 / 画布自适应 / 阈值调优 / 行为准则）

> 执行：QA 最终收口，2026-08-28 12:26–12:35。覆盖主批 T9–T14、追加批（idle_timeout
> 阈值修复、队长行为准则落地）与 P1-D 设计落案（T17–T20 待后续派发）。
> 注：T15 独立 QA 报告未产生（该任务未执行），§6 一致性核对已由本次收口一并完成，
> 在 §最终收口 登记结论。

## 最终收口（2026-08-28 12:35）

### 四门验证：全部通过

| 门禁 | 结果 | 输出摘要 |
| --- | --- | --- |
| `pnpm test` | ✅ | **37 文件 / 537 测试全绿**（Round3 收口基线 35/495，+2 文件 +42 测试） |
| `pnpm typecheck` | ✅ | `tsc --noEmit` exit 0 |
| `pnpm lint` | ✅ | exit 0（0 error；`no-explicit-any` warning 存量维持） |
| `pnpm build` | ✅ | `tsc -p tsconfig.build.json` exit 0，dist 可构建 |

### 收口前修复（QA 边界内直接修复，1 文件 3 处）

`__tests__/planner-append.test.ts`（T14 在途遗留）：①用例对追加编号公式的预期错误
——首批 1 任务后追加批按 `T${既有数+i}` 应为 T2/T3，用例写成依赖 `['T3', 'T1']`，
T3 恰为"追加二"自身缺省编号 → 自引用触发联合判环 `任务依赖成环: …-T3`。已改为
`['T2','T1']` 并同步断言变量（实现 T13 公式正确，纯测试数据缺陷）；②③`script`
Map 的 `'throw'` 联合类型未收窄（TS2339 ×2），补 `step === 'throw' ? undefined : step`
收窄。修复后 4/4 绿、typecheck 0。

### 交付核对（追加批两项）

- **idle_timeout 误杀修复**：`settings-store.ts` `DEFAULT_EXECUTION_IDLE_TIMEOUT_MS
  = 1_200_000` + `execution_idle_timeout_ms` 覆盖键（正数毫秒、非法回落缺省）；
  `index.ts` 装配改用 `loadExecutionIdleTimeoutMs()`；测试锚定缺省值 + 加载器
  3 用例（delegation-service 22 + settings-store 8 全绿）。绝对墙钟 60min 兜底不变。
- **队长行为准则三处落点**：`host-wiring.ts` `CAPTAIN_DISCIPLINE` 常量（单一来源）+
  工具 description 精简版 + 返回 render 完整纪律块（ContentBlock 数组，JSON 主体
  完整）+ `append_to` 参数 schema 补齐；README §5 新增小节；doc/05 §7 条目化并
  声明单一来源。host-wiring 14/14 绿（含双通道锚定用例）。

### §6 一致性核对（代 T15 结论）

| 规格节 | 实现 | 核对结果 |
| --- | --- | --- |
| §6.1 P1-A 追加语义 | `planner.ts`（append_to/域递增编号/复活/联合判环）+ `planner.test.ts` 21 例 + `planner-append.test.ts` 4 例 e2e（入泵/复活/在途依赖放行/无依赖直派） | ✅ 一致 |
| §6.2 P1-B 实时回灌 | `session-stream.ts`（13 例）+ delegation 七发射点 sessionId 统一裁决 + scheduler context 透传 + `index.ts` 装配（`execution_stream` 可配）+ settings 加载器（8 例） | ✅ 一致 |
| §6.3 P1-C 画布自适应 | `dag-panel.tsx` fitDagLayout/DAG_BASE/DAG_FLOOR/dagFontSize（13 例）+ client 同构移植 ResizeObserver（20 例保持，build 后验证） | ✅ 一致 |
| §6.4 P1-D 通知单出口 | 设计落案 + T17–T20 任务拆解（doc/07 P1-D 段），**未实施**（按派发时机约束在 Round4 收口后） | ⏳ 待实施 |
| §7 队长行为准则 | 三处落点 + 单测锚定（见上） | ✅ 一致 |

### 结论：**Go — Round 4 收口**

四门全绿 + 追加批核对通过 + §6.1–6.3 一致性核对通过。执行收口提交（不 push）。
遗留：P1-D（T17–T20）按 doc/07 派发时机约束留待下一轮；40 个存量
`no-explicit-any` warning 维持既有策略。

---

## P1-D 验收（T20/T23，2026-08-28 13:15 追加；六组接线点核对）

### 四门：全部通过

| 门禁 | 结果 |
| --- | --- |
| `pnpm test` | ✅ **38 文件 / 554 测试全绿**（Round4 收口基线 37/537，+1 文件 +17 测试） |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | ✅ 全部 exit 0 |

### 六组接线点逐条核对（doc/05 §6.4）

| # | 接线点 | actor / source | 批量合并 | 回声抑制 | 审计 | 测试锚定 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | scheduler.onExternalCancel | user / task_cancel | — | 测试双向锚定 | ✅ 矩阵内入账 | scheduler.test（RUNNING→CANCELLED 全字段） |
| 2 | scheduler.onExternalRetry 恢复 | user / task_retry | ✅ notifyBatch | 同上 | ⚠️ 派生转移（SKIPPED→BLOCKED）被 AC-TASK-002 拒绝（正确行为，见下） | scheduler.test（批量 2 项+链路复活） |
| 3 | cli-mcp taskRetry/taskSkip/taskCancel-legacy | captain / task_retry·task_skip·task_cancel | — | ✅ 缺省不回声（测试锚定） | ❌ **未补审计（T19 遗漏，见缺口 G1）** | cli-mcp.test 2 例 |
| 4 | repository.cancelTask + 传播 | user / ui_cancel | ✅ notifyBatch（preStatuses 快照） | 测试以 echo=true 验证接线 | 主变更 ✅；传播为派生转移按 AC-TASK-002 拒绝 | dag-panel.test（单条+批量+审计边界） |
| 5 | feedback-router 五动作 + closeExpired | user / feedback_*·close_expired | ✅ closeExpired 一次性合并 | ✅ 缺省不回声 | ❌ **未补审计（T19 遗漏，G1）** | feedback-router.test 3 例（五动作文案逐一比对） |
| 6 | recovery task_repaired | recovery / crash_recovery | — | 不受抑制（缺省即通知，测试锚定） | ✅ 既有 recovery.task_repaired（同位置） | recovery.test 1 例 |

文案格式全部符合 §6.4（`[weave] 任务「{subject}」{from} → {to}（{source}）`；批量头含任务图与项数，超 10 行折叠——notifier 单测 8 例锚定）。**propagateFailure 原地改写共享对象**的 from 误报缺陷已在 T18 修复（preStatuses 快照）并有测试断言。

### 缺口登记（G1，建议微任务）

**接线点 3/5 审计补齐**：cli-mcp 与 feedback-router 的 options 未注入 AuditLog、发电点未同步 `task.status_changed`——违反 §6.4"一处接线同时发审计+通知"条款（属 T19 实施遗漏；两处转移均为矩阵内合法，补齐无 AC-TASK-002 障碍）。**修法**：两模块 options 增 `audit?`，六个发电点各补一条 `audit.record`（约 30 分钟 + 2 测试断言）。按 QA 所有权边界（仅报告与 commit）未代改，回报队长派发。

**AC-TASK-002 审计边界（设计级，非缺陷）**：派生规则转移（WAITING/BLOCKED→SKIPPED、SKIPPED→BLOCKED/WAITING）不入 32 行矩阵，审计按既有校验正确拒绝——通知不受影响、逐条容错。若产品要求派生转移入账，需状态机层新增专用审计事件类型，建议另轮决策（不阻塞本次）。

**生产装配提醒（非缺口）**：六组接线均为可选注入（缺省不发、向后兼容），生产通电需 index/cli 装配层传入共享 `AuditLog` + `TaskStatusNotifier`（notifySession 包装、echoSelfActions 按部署策略）——与 G1 可并入同一装配微任务。

### 结论：**有条件通过（Go with condition）** — P1-D 通知单出口收口

核心目标（旁路全部发电、单出口、噪声控制）六组接线全部验收通过且四门全绿；G1 审计补齐为规格次要条款缺口（3/6 组缺，其中 1 组既有 recovery 审计），已登记待微任务，不构成回退理由。执行收口提交（不 push）。
