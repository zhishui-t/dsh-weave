# 吸收实现终审报告（absorption-review，t7–t11）

- 终审人：QA（质量审核）｜ 2026-09-05 10:10。
- 终审对象（提交映射）：
  - **t7** 等待者：`bacebb6`（DagActivity）+ `13df5dd`（waitForChange 接线）+ `aeb4dd4`（weave_wait_dag_change 工具）+ `b615404`（测试）+ `4490ca4`（设计短文）
  - **t8** 写域：`ab6c717`（writeScope 规范化）+ `0174ebd`（tasks v3 write_scopes）+ `79c9a19`（#pump 重叠警告）+ `e8e47c6`（熔断 RETIRED）
  - **t9** 邮箱：`750c40e`（per-recipient 串行链 + quiet/wakeup + 观察者确认）+ `ce7a656`（feedback-router 分流）
  - **t10** 乐观并发：`6f4d6a6`（v3 两列）+ `0639ac0`（claim + 守卫）+ `bd7b6fb`（协议抽取）+ `3747e81`（测试）
  - **t11** 恢复/处置：`ba4fb96`（core v3 executor_children）+ `669f10a`（对账三分支）+ `1a10d4d`（有界结算）
- 团队规则：终审 1 轮，不通过直接修复。

## 结论速览

| # | 复审项 | 结论 |
| --- | --- | --- |
| a | 语义移植到位（等待者单赢家/串行链/token 迟到拒/对账三分支/有界结算） | **通过**（五项逐一对照，见下） |
| b | 特性开关与旧路径兼容，现有单测语义不变 | **通过**（五个开关面缺省=旧行为；既有用例零改写，全量绿背书） |
| c | schemas v3 三方一致性（t8/t10/t11） | **有条件通过 → 修复后通过**：三方无冲突无遗漏、user_version 正确；**发现中间形态 v3 库自愈缺口（已修复）**；顺手清零 t10 测试 4 个 lint error |
| d | 邮箱 quiet/wakeup 不破坏现有 feedback 流 | **通过**（分流映射正确、投递失败吞错、sink 缺省零行为；feedback-router 既有用例纯增量） |

**总评：通过（附 2 项修复）**。语义移植层零缺陷；1 个迁移健壮性缺口 + 1 组 lint 欠账已当场修复并补测。

## a) 语义移植逐项核对

**参考可得性说明**：官方参考库快照在 `.artifacts/removed-subprojects-*/dsh-agent-teams`（旧版）。
其中 `src/state.ts` 的 `activateTaskAttempt`/`invalidateTaskAttempt` 可直接逐行对照（t10）；
其余四项以「任务关键词 + 各线测试断言 + 实现结构」三角核对（参考库为旧版快照，同名符号
不在本机——如实注明，不作臆断对照）。

| 项 | 参照语义 | weave 实现核对 | 结论 |
| --- | --- | --- | --- |
| 等待者单赢家（t7） | TeamActivity：Map<DagId,Set<Waiter>>、notify 集体唤醒、timeout/abort/notify 三方竞态单赢家、abort 注册窗口补检、close 关闭准入 | `activity-waiter.ts` 五要素逐一在案：`settled` 标志保证 finish 一次（首赢家清定时器/摘监听/移除自身）；注册后 `if (signal.aborted) onAbort()` 补检；`close()` 全唤醒+清 Map；notify 先摘 Set 再 resolve（残留 finish 幂等无害）。测试 `b615404` 锁 9999/10000ms 边界、abort 三形态、单赢家双向竞态 | ✅ |
| 串行链（t9） | TeamJournal.transact per-root tails：`prior.then(op,op)` 前序失败不污染链、tail 吞 rejection、finally 幂等清理 | `mailbox.ts #transact` 三要素逐字对应；键=`${sessionId}:${to}` 收件箱粒度（非全局）；append/claim/ack/release 四操作全入链。测试：同收件箱并发混批 24 append+6 ack → 30 行全序无丢更新 | ✅ |
| token 迟到拒（t10） | activateTaskAttempt：claim 签发 UUID（状态 claimed/清 handoff/清 output）；invalidateTaskAttempt：attemptId=undefined（迟到写 stale）+handoff 串行化+回 pending | `attempt-token.ts`：newAttemptToken=UUID 同源；`applyAttemptGuardedWrite` 以 `WHERE id AND attempt_token AND revision` + `revision+1` 把 invalidate 语义搬进 SQLite 守卫（参考为内存单线程，NULL+revision 双验证是并发环境的等价强化；handoffId 串行化由 revision+1 等价承载）。治理四处（retry/skip/cancel/recovery）统一 invalidate。测试锁协议级「同 token 双写 changes 1→0」与重派换代 | ✅ |
| 对账三分支（t11） | roster.reconcileProvisioning：live→跳过；durable 会话匹配→active；否则 failed 带原因；事务内二次确认幂等 | `recovery.ts + task-liveness.ts`：alive（进程内）/artifacts（executor_children+ACP 索引双源）→保持 RUNNING+`recovery.task_reconciled` 审计；dead→FAILED 且 `WHERE id AND status` 二次确认（changes=0 抛竞态）；探针异常保守回落 dead 并审计原因 | ✅ |
| 有界结算（t11） | lifecycle：close 准入截止 signal、allSettled+超时、cause 链识别取消、超时不抛出必达收尾 | `bounded-settlement.ts`：`#isCancellation` 三路判定（reason 直接命中/DisposedError instanceof/沿 cause 链+环检测）；settle 超时 push 进 failures 不抛；scheduler 接线完备（#admissionClosed 两处准入闸、#inflight Set 捕获、abort 交自收敛、兜底 sweep 用状态机合法词 CANCELLED） | ✅ |

## b) 特性开关与旧路径兼容

| 开关 | 缺省行为 | 证据 |
| --- | --- | --- |
| `RecoveryOptions.liveness` | 未注入 → `dead`（旧行为 RUNNING 一律 FAILED，`#probeRow` 首行分支） | 既有 7 用例原样绿 |
| `childrenStore`（provider） | 未注入 → 纯内存（原行为）；坏 store 降级不阻断派发 | 6 例往返/seed/降级 |
| `memberMailbox`（feedback-router） | 未注入 → `if (!sink) return` 零行为 | 既有 24 例原样绿 |
| `#updateTask` guard | 可选参数，未带 → 原常规 UPDATE 语义 | 95/95 调度器家族绿 |
| `MailboxMessage.delivery` | 缺省 `'wakeup'`（兼容既有 jsonl 行） | 类型注释+用例锚定 |

既有单测语义不变的独立证据：t9 两提交对 mailbox.test/feedback-router.test 的改动**纯增量**
（git diff 删除行仅文件头 import 重排）；全量 775→776（+1 为终审补测）全绿。

## c) schemas v3 迁移一致性（t8/t10/t11）

**无冲突**：tasks 表三列（write_scopes/revision/attempt_token）列名类型独立并存；core.db
executor_children 为新表（CREATE IF NOT EXISTS，无需条件 ALTER）。

**无遗漏**：全新库走组合 DDL 直建（26 列断言）；存量 v2 库升级时三条条件 ALTER
（`when` 谓词查 PRAGMA table_info）+ core v3 建新表，均有迁移用例。

**PRAGMA user_version 正确**：tasks=3、core=3、feedback/knowledgeMeta/imports=1，
升级路径写版本、短路路径不降版本。

**发现的问题（已修复）——中间形态 v3 库自愈缺口**：v3 曾分两批落库（`0174ebd` 仅
write_scopes → `6f4d6a6` 补 revision/attempt_token）。在两批之间迁移过的库
user_version 已达 3，版本门短路不再放行，缺列直达运行时——终审以临时库实证：
守卫 SQL 报 `no such column: revision`，claim/回写链全断。t10 注释曾裁定「仅开发期
形态、可重建」接受此缺口（本机 `~/.dsh/weave` 无 tasks.db，风险确实极小），但
报错形态与根因相距很远、排查成本高，且自愈手段现成（when 谓词本为幂等设计）。
**修复**：`migrate()` 在已达版本分支仍评估条件语句（正常库全部 when=false 零执行），
中间形态库启动即自愈补列。新增用例锁「补列+版本不降+数据保留+守卫 SQL 立即可用」。

**顺手修复**：t10 测试文件 `scheduler-attempt-token.test.ts` 4 个 lint error
（TeamManager/TeamPlanner import、lookup、AttemptSnapshot 未使用）清零——lint 门禁
恢复 0 error / 43 存量 warning。

## d) 邮箱 quiet/wakeup 不破坏现有 feedback 流

- **分流映射**（`deliveryModeOf`）：revise→wakeup（指令触发成员回合）、
  accept/cancel/reopen/expired→quiet（旁路知会）——与用户裁定一致，类型层固化。
- **投递失败吞错**：`#deliverToMember` try/catch 完整包裹（「消息仍在收件箱，恢复路径可重投」），
  不阻断反馈主链路；收件人=任务受派角色（assigned_agent ?? executor）。
- **观察者确认方向安全**：回灌后未观察到 durable 记录 → 保持 queued（宁可重投不误报 delivered）；
  `recoverPending` 观察者优先去重（已落 durable 只补确认不重复回灌）。
- **既有流不受扰**：未注入 sink 时 feedback-router 投递面零行为；既有 24 用例断言原样；
  delivery 缺省 wakeup 使既有 jsonl 行为不变。

## 修复记录

| 修复 | 文件 | commit |
| --- | --- | --- |
| migrate 已达版本时评估自愈性条件语句（中间形态 v3 库补列）+ 1 用例 | `persistence/weave-database.ts`、`test/.../persistence.test.ts` | 本批（见 git log，同本报告提交） |
| t10 测试 4 个 unused lint error 清零 | `test/.../scheduler-attempt-token.test.ts` | 本批 |

## 终验

- 全量单测 **59 文件 / 776 用例全绿**（基线 775 + 终审补测 1）
- `pnpm typecheck` exit 0；`pnpm lint` 0 error / 43 存量 warning（不阻断，遗留账既有）
- 未 push、未安装/升级依赖、未触碰宿主；并行工作树无在途（本轮终审期间工作树始终干净）
