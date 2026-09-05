# rc1 适配全量测试报告（rc1-adaptation-test-report）

- 日期：2026-09-05
- 执行分支：master（本报告产出自任务 t5 验证）
- 基线：`ce7a656`（feedback-router 按消息类型路由）；验证过程中落地 1 个修复提交 `3a69710`（见 §4）
- 配套文档：`doc/architecture/rc1-adaptation.md`（适配面审计，a–e 五点）

## 0. 结论（TL;DR）

**全量测试绿：55 个测试文件 / 748 个测试全部通过。** 首轮全量发现 1 个失败，经证据链定性为**既有失败（非适配引入回归）**，已顺手以 1 行修复转绿并小步提交。定向复跑（scheduler / recovery / delegation-service / feedback-router / session 共 11 文件 159 测试）全绿。各任务 commit 共 15 个全部落位 master，无游离提交。**验收达成。**

## 1. 执行环境与在途改动声明

- vitest 3.2.7，`pnpm test` = `vitest run`。
- 共享工作树，验证期间存在同事在途改动（未触碰、未混入本轮提交）：
  - 首轮全量（08:54）时在途：`src/plugins/weave/safety/circuit-breaker.ts`（其测试 19/19 通过）。
  - 复跑全量（09:00）时在途扩展至 dag/repository、persistence/schemas、scheduler、state/types 等约 12 文件（含新增 `state/attempt-token.ts`）——复跑结果 748/748 全绿，说明在途工作在本快照下亦为绿。
- 纪律遵守：未 push、未安装/升级依赖、未触碰宿主。

## 2. 全量测试（pnpm test）

| 轮次 | 时间 | 结果 | 说明 |
| --- | --- | --- | --- |
| 首轮 | 08:54 | 743 / 744 通过（55 文件，1 失败） | 唯一失败 = team-manager 样例加载测试，定性见 §4 |
| 复跑（修复后） | 09:00 | **748 / 748 通过（55 文件，全绿）** | 测试数 744→748 为同事在途新增用例（如 safety-circuit-breaker 19→23）；team-manager 35/35 通过 |

首轮失败明细：

- `test/unit/plugins/weave/team-manager.test.ts > TeamManager loadTeam/listTeams > loadTeam 成功（含仓库内 examples/team.yaml 样例）`
- 报错：`ENOENT: no such file or directory, open 'K:\work\project\weave\examples\team.yaml'`（test 文件 268 行）

## 3. 定向复跑（pnpm vitest run）

任务指定的五类面共 11 个测试文件，**159 / 159 全部通过**（07:58 一轮独立复跑，7.14s）：

| 类别 | 测试文件 | 用例数 | 结果 |
| --- | --- | --- | --- |
| scheduler | scheduler.test.ts | 18 | ✅ |
| scheduler | scheduler-reflection.test.ts | 6 | ✅ |
| scheduler | activity-waiter.test.ts | 9 | ✅ |
| recovery | recovery.test.ts | 7 | ✅ |
| delegation | delegation-service.test.ts | 27 | ✅ |
| feedback-router | feedback-router.test.ts | 25 | ✅ |
| session | session-delegation.test.ts | 20 | ✅ |
| session | session-events-adapter.test.ts | 9 | ✅ |
| session | session-stream.test.ts | 13 | ✅ |
| session | session-tracker.test.ts | 10 | ✅ |
| session | acp-session-provider.test.ts | 15 | ✅ |

适配重点面均绿：`session-events-adapter`（rc1-b 特性探测适配器）、`session-delegation`（hasPendingToolCall 经适配器读宿主事件）、`activity-waiter`（waitForChange 队长值守）。

## 4. 失败项根因定性

### 失败项：team-manager 样例加载测试 ENOENT

**定性：既有失败，非适配引入回归。**（且与本轮 rc1 适配改动零交集——适配触碰的是依赖声明、session-events-adapter、session-delegation、scheduling、persistence、mailbox/feedback-router，均不涉及 team-manager 与 examples 布局。）

证据链（无需在旧 commit 上重跑测试即闭合）：

1. `4310a3f`（2026-08-30，chore: reorganize docs, e2e and examples into categorized directories）把 `examples/team.yaml` 移入 `examples/teams/team.yaml`——这是 master 线上该路径的最后一次变更（`--diff-filter=D` 唯一命中）。
2. 在适配工作基线 merge `f56228f`（restore own-team-engine）处：`git ls-tree f56228f examples/` 只有 `teams/`，而同一 commit 的 team-manager 测试仍引用 `examples/team.yaml`——**适配起点之前测试即已必坏**（适配首提交 `a306a99` 为 2026-09-05）。
3. 环境因素：本地若残留未跟踪的旧 `examples/team.yaml` 可掩盖该失败，故平时不易暴露；干净 checkout 必现。

**处置**：顺手 1 行修复——夹具 URL 指向 `examples/teams/team.yaml`（样例内容兼容：含 `team_id: changan` 9 角色配置，测试的 `replace('team_id: changan', …)` 无需改动）。提交 `3a69710`（fix(test)），修复后该文件 35/35 通过，全量转绿。

### 通过清单

其余 54 个测试文件首轮即全绿，无待定性失败项。文件级明细见 §2/§3 两轮 vitest 输出（含 executor-bundle、env-subagents-spike 对真实 `@deepseek-ai/dsh-subagent 0.1.1-rc.2` 的加载实证）。

## 5. commit 落位核查（git log）

对上游各任务产物 commit 逐一 `git merge-base --is-ancestor <c> master`，**15/15 全部 ON master**；且 `git log --all --not master` 为空（无任何游离/未落位提交）。

| 任务 | commit | 说明 |
| --- | --- | --- |
| t2 审计 | `a306a99` | rc1-adaptation.md 五点审计 |
| t3 | `92e146f` | report→send_message 零引用实施注记 |
| t4 | `f6b2ee2` + `473f585` | 依赖双版本放宽 + 核验记录 |
| rc1-b 适配 | `a1c29db` + `05e76a1` | session-events-adapter（执行器侧 + hasPendingToolCall） |
| 调度线 | `13df5dd` `aeb4dd4` `bacebb6` `b615404` `4490ca4` | waitForChange / weave_wait_dag_change / DagActivity waiter / 测试 / 设计注记 |
| 状态/持久化 | `ab6c717` + `0174ebd` | writeScope 归一化 + tasks.db v3 |
| 邮箱线 | `750c40e` + `ce7a656` | 串行链投递 + 按消息类型路由 |
| 本任务 | `3a69710` | team-manager 夹具路径修复（§4） |

## 6. 验收判定

- 全量测试绿 ✅（748/748，复跑确认）；
- 失败项均已定性并列入报告 ✅（唯一失败 = 既有失败，非适配回归，已附证据链与修复）；
- 未 push、未安装/升级、未动宿主 ✅。
