# t7-t11 吸收实现全量测试报告（absorption-test-report）

- 日期：2026-09-05
- 执行分支：master，HEAD = `269cd08`（fix(persistence): self-heal same-version partial migrations; absorb review t7-t11）
- 工作树：验证时干净（无任何在途改动，结果无混批干扰）
- 配套文档：`rc1-adaptation.md`（审计）、`rc1-adaptation-test-report.md`（t5 验证）、`rc1-adaptation-review.md`（t6 复审）、`absorption-review.md`（t7-t11 终审）

## 0. 结论（TL;DR）

**全量绿：59 个测试文件 / 776 个测试全部通过；定向复跑 18 文件 / 232 测试全部通过。失败清单为空，无回归亦无既有失败待处置。** t1-t11 共 29 个 commit 全部落位 master 且恰为未推送集合（无 push）；窗口内依赖声明零变更（仅 t4 的五行范围放宽）、锁文件与 node_modules 构件零扰动（全部仍 0.1.1-rc.2）；AGENTS.md 禁提交项零命中。**四项验收全部达成，无需任何修复。**

## 1. a) 全量测试（pnpm test）

| 项 | 值 |
| --- | --- |
| 结果 | **59 文件 / 776 测试全部通过（exit 0）** |
| 耗时 | 20.33s（tests 34.82s 并行折算） |
| 与终审基线对比 | 与 `absorption-review.md` 终验 776/776 一致（吸收线 +1 用例集已含） |

## 2. b) 定向复跑（pnpm vitest run）

任务指定五类核心 + t7-t11 吸收期全部新增/修改测试，18 文件 **232/232 全部通过**（6.10s）。

### 任务指定五类

| 类别 | 测试文件 | 用例 | 结果 |
| --- | --- | --- | --- |
| scheduler | scheduler.test.ts（含 #pump write-scope overlap 警告新用例） | 20 | ✅ |
| scheduler | scheduler-reflection.test.ts | 6 | ✅ |
| recovery | recovery.test.ts | 7 | ✅ |
| delegation | delegation-service.test.ts | 27 | ✅ |
| feedback-router | feedback-router.test.ts（含 quiet/wakeup 分流新用例） | 25 | ✅ |
| 状态机 | task-state-machine.test.ts | 20 | ✅ |

### t7-t11 新增/修改测试（吸收线全景）

| 吸收线 | 来源 commit | 测试文件 | 用例 | 结果 |
| --- | --- | --- | --- | --- |
| 等待者（DagActivity） | `bacebb6`+`b615404` | activity-waiter.test.ts（新） | 9 | ✅ |
| attempt token 守卫 | `0639ac0`+`bd7b6fb`+`3747e81` | scheduler-attempt-token.test.ts（新） | 5 | ✅ |
| 有界结算 | `1a10d4d` | dispose-settlement.test.ts（新） | 6 | ✅ |
| executor_children（core.db v3） | `ba4fb96` | executor-child-store.test.ts（新）+ persistence.test.ts（扩） | 5 + 23 | ✅ |
| liveness 对账 | `669f10a` | recovery-reconcile.test.ts（新） | 9 | ✅ |
| 迁移自愈（终审修复） | `269cd08` | persistence.test.ts（中间形态库自愈用例） | ↑23 | ✅ |
| writeScope 移植 | `ab6c717` | write-scope.test.ts（新） | 8 | ✅ |
| 邮箱串行链 + 分流 | `750c40e`+`ce7a656` | mailbox.test.ts（扩） | 8 | ✅ |
| CircuitBreaker RETIRED | `e8e47c6` | safety-circuit-breaker.test.ts（扩） | 23 | ✅ |
| rc1-b 适配面回归 | `a1c29db`+`05e76a1` | session-events-adapter.test.ts（新）+ session-delegation.test.ts（扩） | 9 + 20 | ✅ |
| 子代理复用 | `eda339b` 后续 | dsh-subagent-reuse.test.ts | 2 | ✅ |

（persistence 23、safety-circuit-breaker 23 为「既有 + 本窗新增」合并后的文件总数。）

## 3. c) commit 落位 / 无 push / 无安装痕迹

### 落位
t1-t11 批次 29 个 commit（`a306a99`…`269cd08`，清单含 t2 审计/t3/t4/t5 验证/t6 复审/t7-t11 吸收九连/邮箱线/调度线/状态持久化线）逐一 `git merge-base --is-ancestor` 验证**全部 ON master**；`git log --all --not master` 为空，无游离提交。

### 无 push
`origin/master..master` 恰为 **29 个提交且集合与 t1-t11 批次逐一相符（sort+diff 为空）**——本批工作全部未推送，纪律成立。

### 无安装痕迹
- 窗口 `a306a99..HEAD` 的 `package.json` diff **仅为 t4（`f6b2ee2`）的五行声明放宽**（dev/peer 三包 + 二包改 OR 范围），零新增依赖、零版本替换；
- 锁文件窗口内仅 `f6b2ee2` 触碰（specifier 三处同步，resolved 版本不变），工作树对 pnpm-lock/package-lock **零 diff**（无 package-lock.json 文件，本项目用 pnpm）；
- node_modules 实装版本：`@deepseek-ai/dsh-agent` / `dsh-commands` / `dsh-subagent` 均 **0.1.1-rc.2**、`cordis` 4.0.1——与锁文件一致，无外来包、无升级扰动。

## 4. d) AGENTS.md 禁提交项检查（§3.8）

| 路径 | git ls-files 计数 | 判定 |
| --- | --- | --- |
| `.artifacts/` | 0 | ✅ 未入库 |
| `subprojects/` | 0 | ✅ 未入库 |
| 非根 `.graphify/` | 0 | ✅ 未入库 |
| 根 `.graphify/` | 0（按约仅为本地输出，不入库） | ✅ |
| `dist/`、`node_modules/` | 0 | ✅ 未入库 |

## 5. 失败清单与定性

**空。** 全量与定向两轮均零失败：无适配引入回归，无既有失败需定性，无需修复（对照 t5 验证轮：彼时唯一失败 team-manager 夹具路径为既有失败，已由 `3a69710` 修复，本轮该文件 35/35 随全量绿）。

## 6. 验收判定

- 全量绿 ✅（776/776）
- 定向复跑全绿 ✅（232/232，含 t7-t11 全部新增测试）
- commit 落位 ✅（29/29 ON master）＋无 push ✅（未推送集合恰为本批）＋无安装痕迹 ✅（零依赖变更、构件零扰动）
- 禁提交项 ✅（四类零命中）
- 纪律：未 push、未安装/升级、未动宿主 ✅
