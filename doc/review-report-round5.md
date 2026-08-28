# Review Report — Round 5（P1-G 调度作用域修复 + 准则修订收口）

> 执行：QA（doc/07 P1-G 段 T32/派发 T33），2026-08-28 14:10。
> 覆盖：T29 全局重泵、T30 run 冷启动重建、T31 通知兜底、append_to 透传契约锚定、
> 队长准则第 5 条修订（禁新建任务组）。

## §P1-G 验收（doc/05 §6.5 逐条核对）

### 四门：全部通过

`pnpm test` **38 文件 / 558 测试全绿**（Round4 P1-D 收口基线 38/554，+4 测试：
跨组拾取 1 + 冷启动重建 2 + append_to 契约 1）；typecheck / lint / build 全部 exit 0。

### 三条规格核对（代码级证据）

| # | 规格 | 证据 | 结论 |
| --- | --- | --- | --- |
| ① | 全局重泵仅角色释放触发且幂等 | 重泵循环全文件**仅 1 处**（`scheduler.ts:454`，`#executeReady` finally 角色释放点）；`#pump` 三重幂等闸（就绪判定/角色忙检查/canTransition）既有未动；T29 交付时做过**判别力反向验证**（旧实现下新用例 waitUntil 超时红） | ✅ |
| ② | 重建 run 治理链路 + 通知兜底 | `#ensureRun` 双治理入口接入（cancel `:180` / retry `:222`）；retry 原 `!runs.has` 早退已删（现存 `runs.has…return` 仅 `#ensureRun:150` 内部幂等守卫）；sessionId 取任务行、parentAgent=undefined；`index.ts:198` `resolveNoticeSession` 兜底统一服务三通知通道（scheduler 主链路 `session ?? resolveNoticeSession` / P1-B / P1-D） | ✅ |
| ③ | 无新增定时器、run 内存策略未变 | scheduler.ts `setInterval/setTimeout` **零命中**；`#runs.delete` 仍在收敛点（`:378`）——收敛即销毁策略不变，仅治理入口按需重建 | ✅ |

两实证场景复验（测试锚定）：跨组饿死——两 DAG 抢同角色，A 组释放后 B 组 WAITING 拾取至收敛（scheduler.test「跨任务组拾取」）；已结束组治理失效——已收敛 DAG 任务置回 WAITING → retry → 重建 run → 执行 → 二次收敛（「run 冷启动重建」2 例，含防御回归）。

### 附带交付核对

- **append_to 透传契约**：源码三层本已贯通（任务前提为 dist 陈旧误判），新增 handler 级契约单测锚定"装配层不过滤入参"，dist 已刷新。
- **准则第 5 条修订**（用户定案）：`CAPTAIN_DISCIPLINE` 常量 + 工具 description + README + doc/05 §7 四处同步，禁令措辞「非用户明确要求，禁止新建任务组」已入测试锚定；旧措辞三文件 grep 零残留。

### 结论：**Go — P1-G 收口**

## 全轮遗留总账（Round3→5 累计，供下轮规划）

| # | 事项 | 状态/建议 |
| --- | --- | --- |
| 1 | 派生转移（SKIPPED 相关）不入审计矩阵（AC-TASK-002 设计边界） | 维持另轮决策；如需入账须新增专用审计事件类型 |
| 2 | 40 个存量 `no-explicit-any` warning | lint 不阻断；策略另定 |
| 3 | R6 保温期接线 / R7 执行器按需检索 / R8 图谱注入（doc/05 §6.6） | 设计落案未实施，另轮 |
| 4 | `echoSelfActions` 部署缺省 false（captain/user 不回声） | 运维可配非缺陷；如需全量回声经装配开启 |
| 5 | client 画布自适应的 ResizeObserver 行为无直接用例（jsdom 无 RO，20/20 锚定未测量回落路径） | 低风险（回落=历史行为），真机验证建议随 e2e 另轮 |
| 6 | `.artifacts/` 调试脚本目录 | lint 已 ignore；属历史工件，建议择机归档 |

执行收口提交（不 push）。
