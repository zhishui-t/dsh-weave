# Pull 模型调度（官方 agent-team 交互面 + weave 治理内核）

> 状态：已实施（P1 pull）
> 日期：2026-09-13
> 分支：`master_prism_0912`（Stage A-E：84a5cf6 / 832b2b3 / 61d8120 / d6c059e）

## 1. 为什么要改

旧模式"一句话目标 → weave_plan_tasks 一次性产出完整 DAG → 宿主调度器推送执行"的仪式成本：
- 队长必须一次答对 assignee/依赖/编号，错则 invalid_plan 重答；
- 7 条 1300 字纪律双通道注入，靠提示词"求"模型自觉（值守轮询、append_to…）；
- 成员是每任务一次性 run，上下文不延续；
- 23 个通知点逐条插话淹没主会话。

官方 DSH agent-team（packages/experimental）的反面恰是：一句自然语言 + 幂等小原语渐进组装、
成员是持久可复用会话（消息冷恢复）、派发是成员自拉（claim）、等待是事件边沿挂起。

## 2. 核心转变

| 维度 | 旧（push） | 新（pull） |
|---|---|---|
| 成员 | 每任务一次性 run | **持久队友**（`dsh` 执行器 = fork continuable，首派 seed 队长前缀；后续 sendMessage 唤醒：running 插话 / idle 开回合 / absent 冷恢复） |
| 派发 | 调度器推 executeTask | 就绪 → `memberWake` 唤醒 owner；成员 `weave_task_claim` 自拉（WAITING→RUNNING，attempt/CAS） |
| 回报 | run 结果回写 | 成员 `weave_task_update`（complete/release/fail）→ 完整结算链（通知→反思→下游晋升/传播→收敛） |
| 队长工具 | plan_tasks + 6 治理 | 小原语：task_create（单任务直派）/ spawn_teammate / send_message / list_agents / task_claim / task_update / task_list + wait_dag_change（事件等待） |
| 纪律 | 7 条 1300 字双通道 | 4 条（wait_dag_change 值守 / 增量追加 / 主动推进 / 质量分层），单通道 |

**不变的内核**：SQLite DAG/14 态状态机、attempt token CAS、熔断、恢复对账、审计、
prism 台账镜像、Dashboard 任务图。pull 只改变"状态推进的触发权"与"成员生命周期"。

## 3. 关键语义

- **角色额度（pull）**：同团队同角色同时只允许一个 RUNNING（claim/complete 在库内校验；
  唤醒前检查 + 认领时复查），替代 push 的 activeByRole 占用。
- **唤醒守卫**：`#pullWoken` 防 pump 重入重复唤醒；release 后守卫保留（防"卡住→重唤醒"死循环），
  队长 task_retry（INTERRUPTED→WAITING）或重开任务后再次唤醒。
- **release = RUNNING→INTERRUPTED**（error_type=member_released）：状态机无 RUNNING→WAITING；
  重开走既有 retry 治理。
- **identity**：成员侧工具经 `exec.agent.id → roster.findByAgentId` 反查成员，
  claim/update 校验 `task.assigned_agent === member.role_id`。
- **ACP 成员边界**：zcode/workbuddy 成员 = sessionKey 会话唤醒（`acpWake`），不做任务板自拉
  （外部进程无 weave 工具面，写权不外放）；roster 状态照常呈现。

## 4. 模块与工具面

- `team/member-runtime.ts`：roster（team_members 表，core.db v4）、ensureMember/deliver/
  list/get/findByAgentId/interrupt、5 态推断、成员 bootstrap（pull 工作流约定注入）。
- `scheduling/scheduler.ts`：`isPullTask`、`#wakePullTask`（就绪唤醒）、`claimTask/
  completeTask/failTask/releaseTask`（结算链复用）。
- 工具：`weave_task_create / spawn_teammate / send_message / list_agents`（队长）+
  `weave_task_claim / task_update / task_list`（成员）。plan_tasks 保留为批量糖。
- 面板：sessionStatus 叠加 roster 状态（成员卡 待唤醒/异常/空闲/执行中）。

## 5. 已知边界与后续

- 成员运行无自动超时（会话级长驻）：卡住靠队长 send_message 询问 / interrupt / cancel 治理。
- 会话面板过程输出对 pull 成员 = 成员自身会话流（DSH 原生可见）；任务 result 取交付摘要。
- plan_tasks 未废弃（批量糖）；通知进一步降噪（完成通知格式）待真实使用反馈迭代。
