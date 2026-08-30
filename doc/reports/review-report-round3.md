# Review Report — Round 3（T4 质量门禁与一致性检视）

> 执行：QA（doc/tasks/06-任务文档-Round3.md T4），2026-08-28 10:19–10:22
> 前置：T1（reflection.test.ts TS2532×6）/ T2（no-control-regex）/ T3（lint 存量治理）已合入。
> 本报告为唯一新增文件；除报告外未改任何代码（所有权契约）。

---

## 1. 总结论：**不通过（No-Go）**——被并行任务半成品阻塞，非反思链路本身问题

反思沉淀链路（doc/05 R1–R5）的**文档-实现一致性核对六项全部通过**，typecheck/build 两门绿；
但 `pnpm test` 与 `pnpm lint` 两门红，根因均**不在 T1–T3 交付物内、不在 T4 可修范围内**，需队长派发微任务后重跑本门禁。

| 门禁 | 结果 | 摘要 |
| --- | --- | --- |
| `pnpm test` | ❌ **493/495，2 failed** | 均在 `scheduler.test.ts`（152/284 行两用例），planner 抛 `依赖引用不存在: t1`；`planner.test.ts` 自身 19/19 绿 |
| `pnpm typecheck` | ✅ exit 0 | 全项目 0 error（T1 修复有效） |
| `pnpm lint` | ❌ **4 errors / 40 warnings** | 4E 位于 `e2e/dag_dom.spec.ts:20`、`e2e/screenshot_probe.spec.ts:18`、`scripts/captain-plan-tasks.mjs:1-2`——T3 上报过的边界外存量（doc/06 T3 清单漏列项） |
| `pnpm build` | ✅ exit 0 | `tsc -p tsconfig.build.json` 成功，dist 可构建 |

## 2. 阻塞项根因与建议处置

### B1（P0）· scheduler.test.ts 两用例未适配 planner 缺省别名大写化

- **事实链**：本轮 QA 时窗内（10:01 架构师全量复核时 35 文件/495 全绿之后），出现并行改动：
  `planner.ts` 缺省任务别名 `t${n}` → `T${n}`（2 处：注释 + `refIds` 归一），`planner.test.ts` 配套更新且绿；
  但 `scheduler.test.ts` 的「无依赖的多角色任务并行执行」「max_concurrent_tasks=1 的角色串行」两用例仍用
  `depends_on: ['t1', 't2']` 小写引用 → `planner.ts:198` 抛 `依赖引用不存在`。
- **单文件复现**：`pnpm vitest run src/plugins/weave/__tests__/scheduler.test.ts src/plugins/weave/__tests__/planner.test.ts`
  → 1 failed（2 tests）+ 1 passed（19 tests）。
- **建议微任务（T5）**：developer 角色，仅改 `src/plugins/weave/__tests__/scheduler.test.ts`，
  把两用例 `depends_on` 的小写 `t1/t2` 改为大写 `T1/T2`（或给任务 spec 显式 `id`），断言语义不变；
  验证 `pnpm vitest run src/plugins/weave/__tests__/scheduler.test.ts` 8/8 绿。
  **注意**：派发前先确认该并行任务是否仍在进行——若其负责人稍后自行补齐，T5 可撤销。

### B2（P1）· lint 边界外 4 存量 error（T3 已上报，此处正式登记）

- `e2e/dag_dom.spec.ts:20` `weaveTab` unused → 删赋值或 `_` 前缀；
- `e2e/screenshot_probe.spec.ts:18` `no-empty` → 块内补注释；
- `scripts/captain-plan-tasks.mjs:1-2` `homedir`/`join` unused → 删两行 import。
- **建议微任务（T6）**：developer 角色，约 2 分钟；不推荐把 `e2e/**`/`scripts/**` 加入 ignores（e2e 是值得 lint 的真实代码）。

## 3. doc/05 §3.1–§3.5 文档-实现一致性核对（六项全过）

| # | 规格条目 | 实现位置 | 核对结果 |
| --- | --- | --- | --- |
| ① | §3.1 解析容错：标记兼容 0..6 个 `#` 与 CRLF；多块；START 无 END/非法 JSON/缺 title\|content → invalid 计数不抛错；type 枚举外→other、tags 非法→[]、layer 非法→undefined | `reflection.ts:38`（`MARKER_RE`）、`:19-20`（枚举集合）、`:47-70`（parseBlock 规整）、`:78-108`（主循环） | ✅ 逐条一致；8/8 单测绿 |
| ② | §3.2 layer 路由表（project/role/shared + instance 降级 project 记 error）、visibility 映射、tags 三元组 `executor:{x}/role:{y}/source:weave-reflection`、status=candidate、审计字段四项、审计失败不回滚 | `reflection-service.ts:64-71`（降级）、`:74-86`（scope/visibility/tags）、`:94-107`（审计+失败收集） | ✅ 一致；D2 消毒表述与 T2 后实现（codePointAt<0x20 等价重写）仍相符 |
| ③ | §3.3 钩子签名（task/role/team/text/status）、COMPLETED 与 FAILED 各触发一次、异常 `log.warn` 吞掉、`>0` 发 `[weave] 反思沉淀 n 条候选知识（待审核）` | `scheduler.ts:47`（options）、`:437/:459`（两触发点）、`:467-486`（#runSettledTextHook） | ✅ 一致；4/4 单测绿（含钩子抛错不阻断、不注入行为不变） |
| ④ | §3.4 装配参数映射（task.id→taskId、role.executor→executor、role.id→roleId、project_id/version、text） | `index.ts:180-199` | ✅ 一致；D1（自建 `AuditLog` 实例）与 §1.5.3 偏差登记相符 |
| ⑤ | §3.5 注入格式 `- [layer] title（id）：content` | `delegation-service.ts:237`；断言 `delegation-service.test.ts:143-144/209` | ✅ 一致 |
| ⑥ | 审计事件三处注册（TYPES 数组/联合类型/必填字段表） | `audit/audit-log.ts:15/40/58` | ✅ 一致；audit-log 14/14 绿（含缺字段异常路径） |

**偏差复核**：D1（`index.ts` 自建 AuditLog 而非共享实例）、D2（双层文件名消毒）与 doc/05 §1.5.3 / §3.2 修订表述一致，无需改文档。
本时点未发现新的文档-实现偏差，doc/05 无需修订。

## 4. 遗留事项汇总

| 优先级 | 事项 | 责任建议 |
| --- | --- | --- |
| P0 | B1：scheduler.test.ts 两用例适配 `T1/T2` 大写别名（并行 planner 改动遗留） | 微任务 T5（先与并行任务负责人确认归属） |
| P1 | B2：lint 边界外 4E 清理（e2e×2 + scripts×2） | 微任务 T6 |
| P2 | 40 个 `no-explicit-any` warning（存量策略另定，不阻断退出码） | 另轮 |
| P2 | doc/06 T3 清单编制方法缺陷：lint 存量按目录估算漏列 4E（已在 T3 执行时发现并上报） | 后续拆解任务应逐项穷举 |
| 备注 | doc/05 §1.5.1「35/495 全绿」为 10:01 快照，B1 修复后即恢复成立，文档无需改 | — |

## 5. 重验指令（B1/B2 修复后）

```bash
pnpm test        # 预期 35 文件 / 495 全绿
pnpm typecheck   # 已绿，保持
pnpm lint        # 预期 exit 0（仅剩 no-explicit-any warning）
pnpm build       # 已绿，保持
```

四门全绿后 Round 3 即可收口提交；本次一致性核对结论（第 3 节）在 B1/B2 修复后仍然有效，无需重核。

---

## 6. 重验结果（收口，2026-08-28 10:32）

B1/B2 微任务合入后重跑四门，**全部通过**：

| 门禁 | 结果 | 输出摘要 |
| --- | --- | --- |
| `pnpm test` | ✅ | **35 文件 / 495 测试全绿**（Test Files 35 passed；Tests 495 passed，无 failed/skip 异常） |
| `pnpm typecheck` | ✅ | `tsc --noEmit` exit 0，0 error |
| `pnpm lint` | ✅ | exit 0，**0 error** / 40 warnings（全部为存量 `no-explicit-any`，属既定可接受范围，见 §2 B2 与 §4） |
| `pnpm build` | ✅ | `tsc -p tsconfig.build.json` exit 0，dist 可构建（宿主运行载体） |

**B1/B2 关闭确认**：

- **B1（P0）✅ 已关闭**：`scheduler.test.ts` 三处小写 `t1/t2` → `T1/T2`（两处 `depends_on` + 同用例内 taskId 后缀顺序断言，断言语义不变），`scheduler.test.ts` 8/8 绿、`planner.test.ts` 13/13 绿、全量 495/495 绿。核对说明：任务书所写「planner 19/19」系本报告 §2 的笔误（19 为当时两文件合计通过数），planner 单文件实为 13 用例，以本次实测为准。
- **B2（P1）✅ 已关闭**：`e2e/dag_dom.spec.ts` 删除未使用 `weaveTab` 赋值（locator 惰性求值，无行为影响；`_` 前缀方案因本仓未配 `varsIgnorePattern` 不适用）；`e2e/screenshot_probe.spec.ts:18` 空 catch 补占位注释（`no-empty` 豁免含注释块）；`scripts/captain-plan-tasks.mjs` 删除未使用 `homedir`/`join` import。lint error 4 → 0。

**遗留（不阻断收口，均已在 §4 登记）**：40 个 `no-explicit-any` warning（存量策略另轮）；P1/P2 展望项（R6 保温期接线、R7 执行器按需检索、R8 图谱注入）按 doc/05 §6 另轮实施。

### 结论：**Go — Round 3 收口**

四门全绿 + §3 六项一致性核对通过 + B1/B2 关闭，Round 3（反思沉淀链路 R1–R5 + 修复/治理/回归）达到交付标准，执行收口提交。

