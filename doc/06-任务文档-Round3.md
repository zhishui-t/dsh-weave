# 06 · 任务文档 — Round 3 收尾（反思沉淀链路修复 + 全量回归）

> 依据：`doc/05-反思沉淀与技能落地-优化设计文档.md` §1.5 现状评估（架构师复核 2026-08-28）。
> 背景摘要：R1–R5 反思链路已实施且 `pnpm vitest run` 35 文件 / 495 测试全绿；
> 遗留 typecheck 6 错、lint 新增 1 错 + 存量 33 错。**无文件需要回退**（见 doc/05 §1.5.4）。
> 任务编号沿用 T1、T2… 格式；T1–T3 按文件所有权切分、互不触碰对方文件，可并行；
> T4（QA）必须最后执行。

---

## T1 · 修复 reflection.test.ts 六处 TS2532（typecheck 清零）

- **subject**: `__tests__/reflection.test.ts` 六处 `Object is possibly 'undefined'` 修复
- **建议角色**: developer-1
- **description**:
  - 规格引用：doc/05 §1.5.1——`pnpm typecheck` 6 errors 全在本文件，行号
    58 / 83 / 84 / 85 / 92 / 102，均为 `noUncheckedIndexedAccess` 下 `blocks[0].xxx`
    直接成员访问。**测试语义全部正确，禁止改断言内容**，只做空安全修复：
    `const [first] = blocks` + `expect(first).toBeDefined()` 后 `first!.xxx`，
    或 `blocks[0]!` 非空断言（与本仓库 scheduler-reflection.test.ts 等既有风格一致）。
  - 文件所有权边界：**只许改 `src/plugins/weave/__tests__/reflection.test.ts`**；
    不许碰 reflection.ts / reflection-service.ts 及其他任何文件。
  - 验证命令：
    ```bash
    pnpm vitest run src/plugins/weave/__tests__/reflection.test.ts   # 8/8 仍全绿
    pnpm typecheck                                                    # 本文件 0 error（rpc/client 等他人范围不计）
    ```
- **depends_on**: （无）

---

## T2 · 修复 reflection-service.ts 文件名消毒正则的 lint error

- **subject**: `reflection-service.ts:134` `no-control-regex` 修复（唯一本轮新增 lint error）
- **建议角色**: developer-2
- **description**:
  - 规格引用：doc/05 §1.5.2 批次 A——文件名预消毒正则
    `/[\\/:*?"<>|\u0000-\u001f]/g` 中控制字符类触发 `no-control-regex`。
    消毒意图本身正确（剔除文件系统非法字符含控制字符），**修复方式任选其一**：
    ① 该行上方加 `// eslint-disable-next-line no-control-regex` 并注释"文件名消毒需显式剔除控制字符"；
    ② 改写为不含字面控制字符的等价实现（如按 `codePointAt` 过滤 `< 0x20`）。
    不改变消毒行为（两种方式须保持替换结果一致）。
  - 文件所有权边界：**只许改 `src/plugins/weave/reflection-service.ts`**；
    不许碰其测试（如需补用例可加在 `__tests__/reflection-service.test.ts`，但预期不需要）。
  - 验证命令：
    ```bash
    pnpm lint src/plugins/weave/reflection-service.ts   # 0 error 0 warning
    pnpm vitest run src/plugins/weave/__tests__/reflection-service.test.ts   # 7/7 仍全绿
    ```
- **depends_on**: （无）

---

## T3 · lint 存量治理（33 个存量 error 清零，使 `pnpm lint` 可全绿）

- **subject**: `.artifacts` 目录加入 eslint ignore + src 内两个存量 unused 清理
- **建议角色**: developer-3
- **description**:
  - 规格引用：doc/05 §1.5.1——lint 存量 33E 分布：
    ① `.artifacts/*.mjs`（约 31 处 `document`/`getComputedStyle` `no-undef`，该目录是
    浏览器调试脚本工件，非工程代码）→ 在 `eslint.config.mjs` 的 `ignores` 数组追加
    `'.artifacts/**'`（现有 ignores：dist/node_modules/coverage/*.log）；
    ② `src/client/index.ts:3976` `TeamMessagePanel` 定义未使用（HEAD 存量，函数整体删除，
    删前确认全文件无引用、UI 测试仍绿）；
    ③ `src/plugins/weave/__tests__/client-bundle.ui.test.tsx:24` import 中 `vi` 未使用
    （从 import 列表移除 `vi` 即可）。
    不处理 40 个 `no-explicit-any` warning（存量策略另定，warning 不阻断 lint 退出码）。
  - 文件所有权边界：**只许改 `eslint.config.mjs`、`src/client/index.ts`、
    `src/plugins/weave/__tests__/client-bundle.ui.test.tsx`** 三个文件；与其他任务零交集。
  - 验证命令：
    ```bash
    pnpm lint                                            # exit 0（仅剩 warning）
    pnpm vitest run src/plugins/weave/__tests__/client-bundle.ui.test.tsx   # 20/20 仍全绿
    pnpm vitest run src/plugins/weave/__tests__/dashboard.test.tsx src/plugins/weave/__tests__/dag-panel.test.tsx   # client 改动回归
    ```
- **depends_on**: （无）

---

## T4 · QA 全量回归 + 文档-实现一致性检视（收尾闸门）

- **subject**: Round 3 全量回归（test/typecheck/lint/build）+ doc/05 vs 实现逐条核对，产出检视报告
- **建议角色**: qa
- **description**:
  - 规格引用：doc/05 §2 状态列与 §1.5 全节。前置：T1/T2/T3 已合入。
  - 全量验证（四项全部通过才算收口）：
    ```bash
    pnpm test         # 35 文件 / 495+ 测试全绿
    pnpm typecheck    # 0 error
    pnpm lint         # exit 0（允许存量 no-explicit-any warning）
    pnpm build        # dist 可构建（宿主运行加载 dist/，必须可构建）
    ```
  - 文档 vs 实现逐条核对（对 doc/05 §3.1–§3.5 五节规格逐条打勾）：
    1. §3.1 解析容错规则 ↔ `reflection.ts`（标记兼容/CRLF/多块/invalid 计数/type|tags|layer 规整）；
    2. §3.2 路由表与 tags 三元组/审计字段 ↔ `reflection-service.ts`（含 D1/D2 偏差表述与实现一致性）；
    3. §3.3 钩子签名/触发点/异常吞掉/通知文案 ↔ `scheduler.ts`；
    4. §3.4 装配参数映射 ↔ `index.ts`（task.id→taskId、role.executor→executor 等）；
    5. §3.5 注入格式 ↔ `delegation-service.ts:237` 与测试断言；
    6. 审计事件三处注册 ↔ `audit/audit-log.ts`（TYPES/联合类型/必填字段表）。
    发现不一致时：小偏差直接修文档并在报告登记；实现级问题回报队长重开任务，不越权扩改。
  - 产出：`doc/review-report-round3.md`（核对表 + 四项命令输出摘要 + 遗留事项）。
  - 文件所有权边界：只新增 `doc/review-report-round3.md`；发现他人工件问题只登记不代改。
- **depends_on**: T1, T2, T3

---

## 附：派发速览

| 任务 | subject | 角色 | depends_on | 文件所有权 |
| --- | --- | --- | --- | --- |
| T1 | reflection.test.ts 六处 TS2532 修复 | developer-1 | — | `__tests__/reflection.test.ts` |
| T2 | reflection-service.ts no-control-regex 修复 | developer-2 | — | `reflection-service.ts` |
| T3 | lint 存量治理（.artifacts ignore + 2 处 unused） | developer-3 | — | `eslint.config.mjs`、`src/client/index.ts`、`__tests__/client-bundle.ui.test.tsx` |
| T4 | QA 全量回归 + 一致性检视 | qa | T1,T2,T3 | 新增 `doc/review-report-round3.md` |
