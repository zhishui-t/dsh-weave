# DAG 变更一次性等待者（activity-waiter）

- 状态：已落地（master，2026-09）
- 参考实现：dsh agent-team `activity.ts`（TeamActivity，本地源码
  `deepseek-harness/packages/experimental/agent-team/src/activity.ts`），按 DAG 语境移植。
- 解决的问题：队长值守此前只能 15 秒级轮询 `weave_get_status`（CAPTAIN_DISCIPLINE 第 2 条），
  空转 RPC 多且状态感知延迟最高一个轮询周期；本机制提供"状态变更边沿 → 唤醒"的等待面。

## 1. 组件与职责

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `DagActivity` | `scheduling/activity-waiter.ts` | 一次性等待者数据面：`Map<dagId, Set<Waiter>>`、`wait/notify/close` |
| `WeaveScheduler.waitForChange` | `scheduling/scheduler.ts` | 队长入口：在途判定 + 注册等待者；`#updateTask`/`#afterTaskSettled` 两点 notify |
| `WeaveMcp.waitDagChange` | `host/cli-mcp.ts` | 工具层：经 `executionHooks.waitForChange` 调度器，附带状态快照 |
| `weave_wait_dag_change` 工具 | `host/host-wiring.ts` | dsh-tools 注册（`executionHooks` 未注入时报 configuration_error） |

## 2. 并发语义（移植要点）

1. **单赢家**：`wait` 内部 `settled` 标志保证 timeout/abort/notify 三方竞态只有
   首个到达者结算；赢家负责清定时器、摘 abort 监听、把其余竞争者从 Set 中移除，
   后到者静默返回（无二次 resolve/reject、无 unhandled rejection）。
2. **AbortSignal 注册窗口补检**：`throwIfAborted` 预检与 `addEventListener('abort')`
   之间是同步空档，abort 不会重放；注册后立即 `if (signal.aborted) onAbort()` 再查一次。
3. **边沿不重放**：notify 只唤醒"已注册"的等待者，注册前的变更不补发。漏看窗口
   由 `waitDagChange` 返回值里的任务状态快照兜底（唤醒即带最新状态，免去一次
   get_status 往返；调用方对比快照即可发现漏边）。
4. **notify 幂等零开销**：无等待者时 `notify` 直接返回，调度器主链路（高频写入）
   不为等待功能付任何代价。
5. **close**：`scheduler.dispose()` 转调 `DagActivity.close()`，关闭准入并唤醒全部
   残留等待者（插件卸载不悬挂外部调用方）。

## 3. 在途判定（noProgress 语义）

`waitForChange(dagId, timeoutMs, signal)` 先 `loadDag`（不存在 → `task_not_found`，
与 `start` 语义一致），再判在途：

- 任一任务 DB 状态为 `RUNNING`，**或**
- 任务 id 出现在 `#controllers`（运行中）/`#dispatchGuards`（派发窗口）/
  `#activeByRole`（queued/running 成员占用）任一集合。

无在途 → 立即返回 `{timedOut:false, noProgress:true}`（等了也白等，调用方应直接
推进）；有在途 → 注册等待者，返回 `{timedOut, noProgress:false}`。

`timeoutMs` 必须为 10000~3600000 整数（`invalid_argument`）；abort 时若
`signal.reason` 非 Error 则收敛为 `WeaveError('wait_aborted')`。

## 4. notify 接线点

| 点 | 说明 |
| --- | --- |
| `#updateTask` | 同一 SQLite 事务内顺带 `SELECT dag_id`，事务外 notify；覆盖 RUNNING/COMPLETED/FAILED 等全部主链路写入（`#forceTransition` 亦经此） |
| `#afterTaskSettled` | 传播落库后补一次边沿：覆盖下游 SKIPPED 批量写入（`#persistSkipped` 不走 `#updateTask`） |
| 心跳 | 刻意**不** notify：心跳只刷 `updated_at`，非状态变更，不应唤醒值守 |

## 5. 队长使用契约

工具描述（`weave_wait_dag_change`）与返回值约定：在途任务存在时以本工具替代
15 秒级轮询；`no_progress=true` 时不许空等，直接查状态推进；唤醒后按返回快照
判断下一步（继续等 / 通报进度 / 治理失败项）。

## 6. 测试锚点

`test/unit/plugins/weave/activity-waiter.test.ts`（9 例）：多等待者集体唤醒 + 集合
清理、fake-timer 超时边界（9999/10000ms）、abort 三形态（Error 透传 / 非 Error 收敛
wait_aborted / 预中止拒绝）、notify-abort 双向单赢家、timeoutMs 校验、close 准入
关闭，以及调度器级 noProgress 立即返回、在途收敛唤醒、`task_not_found` 透传。
