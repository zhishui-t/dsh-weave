# QA 审核报告：doc/design/09-图谱全量实施设计.md（第 3 轮）

> 审核人：qa（ds梁子）
> 审核对象：`doc/design/09-图谱全量实施设计.md`（第 3 轮修订，文档状态行自述「已按 QA 第 2 轮残留 4 项修订」）
> 上一轮结论：`doc/reports/review-report-09-round2.md`（不通过，P0-2/P0-3/P0-5/P0-6 残留）
> 结论：**不通过（P0-2 / P0-3 已闭合；P0-6 负向用例与 spec 清单闭合，mock 端点清单未真正闭合；P0-5 出现新的所有权冲突，进入第 4 轮）**
> 审核原则：只核对第 2 轮残留的 4 项（P0-2 / P0-3 / P0-5 / P0-6）增量，不扩散。

---

## 1. 本轮实际核对的事实

| 核对点 | 证据 | 结论 |
| --- | --- | --- |
| P0-2 Obsidian CLI 落点/命令 | doc09 L49（`src/plugins/weave/obsidian/cli.ts` 待建）、L112-118（`/weave obsidian generate/open/reindex/status [--vault <path>]`） | 已闭合 |
| P0-2 Obsidian 错误码 | doc09 L106-110：Vault 不存在/不可写→`configuration_error`、指纹/同步失败→`internal`、不可安全合并→`conflict_detected`、CLI 用法错误→`invalid_argument` | 已闭合 |
| P0-2 边界场景 | doc09 L170-177：用户未改/已改/双方改/删除/首次生成/重命名/二进制附件/增量刷新 8 行矩阵 | 已闭合 |
| P0-3 document 错误码 | doc09 L135-139：白名单外/超大小/base64 失败/目录逃逸→`invalid_argument`、转换失败→`document_conversion_failed`、job 不存在/过期→`configuration_error` | 已闭合 |
| P0-5 build() 认领 | doc09 L199 T1 内容含「GraphService `build()` 改造 + 接入 RPC：`code/*`」；L215 该文件（含 build() 改造）唯一 owner=developer-1(T1) | 第 2 轮两处矛盾已闭合 |
| P0-5 code 段 owner 对齐 | doc09 L220 `rpc.ts` code 段=developer-1(T1)、L224 `query-service.ts` code 段=developer-1(T1) | 第 2 轮两处矛盾已闭合 |
| P0-5 集成任务与所有权表 | doc09 L204 T-INT 内容写「在 `index.ts`/`rpc.ts`/`query-service.ts` 完成…组装与路由接线」，但 L211-233 所有权表只给 T-INT 认领 `index.ts`（L229）；`rpc.ts`/`query-service.ts` 只列了 code/knowledge/document/obsidian 四个业务段，均归 T1/T-KG/T6/T3，没有 T-INT 的「前缀路由/组装段」 | ❌ 新的唯一 Owner 冲突 |
| P0-5 冲突的现实落点 | 仓库现状 `src/plugins/weave/rpc.ts` L499 前缀数组 `['task/','knowledge/','audit/','session/','code/','document/']` 正是需要 T-INT 改动的路由接线点（本轮还要加 `obsidian/`），所有权表未覆盖该行归属 | 佐证该缺口真实存在 |
| P0-6 负向用例结构 | doc09 L254-294：code 3 条（C1-C3）、knowledge 3 条（K1-K3）、obsidian 4 条（O1-O4）、document 4 条（D1-D4）、控制台 3 条（U1-U3），均为「前置/操作/期望」三列 | 已闭合 |
| P0-6 e2e spec 清单 | doc09 L298-303：`graph-positive/negative`、`knowledge-graph`、`obsidian`、`document-convert`、`console-pages` 六个 spec 文件，且映射 C/D/K/O/U 用例号 | 已闭合 |
| P0-6 mock 端点清单 | doc09 L304 原文：「mock 端点清单：`code/*`、`knowledge/graph`、`obsidian/*`、`document/*` 全部用真实 RPC + 临时目录；不 mock 成功路径」——名为清单，实际没有任何一个 mock/故障注入端点被列明 | ❌ 未真正闭合 |
| P0-6 脚本现状（顺带复核） | `package.json#scripts.code:scan` = `graphify extract src --out . --no-description --no-label && graphify flows build --graph .graphify/graph.json`（与第 2 轮实测一致，脚本侧仍闭合）；doc09 L28 却仍写「已可用，但需按 P0-6 补 `flows build`」 | 同节事实陈旧，需顺手改 |

---

## 2. P0 逐项核对结论

### P0-2 Obsidian CLI / 错误码 / 边界 —— ✅ 已闭合

- CLI 文件落点：L49 已补 `src/plugins/weave/obsidian/cli.ts`，与 L47-48 的 `obsidian-service.ts` 配套，T3（L202）含 CLI 交付；
- CLI 命令：L112-118 给出四个子命令与统一 `--vault <path>` 参数；
- 错误码：L106-110 覆盖 vault、指纹/同步、不可合并、CLI 用法四类，与第 2 轮建议一致；
- 边界：L170-177 补齐重命名（保留用户命名+alias）、二进制附件（只同步 frontmatter/链接）、增量刷新（只重算变更条目、避免 mtime churn）三行，第 2 轮三处场景缺口全部补上；
- O1 负向期望「`configuration_error` 或自动创建，文档明确」：L107 已明确选择 `configuration_error` 分支，口径自洽。
- 结论：第 2 轮 P0-2 放行条件达成。

### P0-3 document 错误码 —— ✅ 已闭合

- L135-139 已按第 2 轮建议补出四类映射：入参类错误（白名单外/超大小/base64 失败）与路径类错误（目录逃逸/非法路径）→`invalid_argument`；转换失败→`document_conversion_failed`；job 不存在/已过期→`configuration_error`；
- 与 D1-D4 负向期望（L283-286）一一对应，可验收。
- 不阻塞的补强建议（供第 4 轮顺手补一行）：L126 `document/status` 的 `error?` 字段未定义形状，建议写为 `error?: { code, message }`，否则「错误码」没有明确的观测字段，T8 只能靠 message 断言。
- 结论：第 2 轮 P0-3 放行条件达成（设计层）。

### P0-5 文件所有权与 build() 改造 —— ❌ 未闭合（新增一处同源冲突）

第 2 轮的两处残留已闭合：

- build() 改造：T1 内容（L199）已含改造项，所有权表（L215）把 `graph-service.ts`（含 build() 改造）唯一归给 developer-1(T1)，角色与 owner 一致；
- code 段 owner：L220/L224 已把 `rpc.ts`、`query-service.ts` 的 code 段归 developer-1(T1)，与 T1 内容对齐。

但同一「文件唯一 Owner」问题在集成任务上再次出现：

- **冲突点**：L204 T-INT 明确要「在 `index.ts`/`rpc.ts`/`query-service.ts` 完成图/Obsidian/Document 服务组装与路由接线」；L211-233 所有权表只给 T-INT 认领 `index.ts`（L229），`rpc.ts` 和 `query-service.ts` 的所有权只按 code/knowledge/document/obsidian 四个业务段给了 T1/T-KG/T6/T3，**没有 T-INT 的「前缀路由/组装段」**。T-INT 改这两个文件时，与四段 owner 的排他权冲突；若 T-INT 不改，L204 的交付内容无人执行，路由接线落空。
- **现实佐证**：仓库现状 `rpc.ts` L499 的前缀数组路由就是 L204 所述「路由接线」的实际改动点（本轮还需加入 `obsidian/`），该行/段的归属在 L211-233 表中不存在。
- **影响**：按现状派发，T-INT 与 T1/T6/T3 会同时改 `rpc.ts`/`query-service.ts`，或集成任务留空，直接复现第 1 轮 P0-5 担心的文件冲突/无人接线风险。
- **建议改法（二选一）**：
  1. 保持 T-INT 只认领 `index.ts`：把 L204 改为「在 `index.ts` 完成服务组装与挂载」；同时把 `rpc.ts` 前缀路由段、`query-service.ts` dispatch/挂载段分别写进各业务任务（T1/T-KG/T6/T3）的 T 内容，由段 owner 自行接线；
  2. 保持 T-INT 负责集成：在 L211-233 增补两行「`rpc.ts` 前缀路由/组装段」「`query-service.ts` dispatch/挂载段」→ developer-2（T-INT），并明确其余四段仍归原 owner（段内不得跨段）。
- 结论：第 2 轮 P0-5 的两个点名残留已闭合，但「文件唯一 Owner」总目标未达成，阻塞第 4 轮放行。

### P0-6 负向用例与 e2e 清单 —— ⚠️ 部分闭合，残留 mock 清单 1 项

已闭合：

- 负向用例已按能力分组，全部为「前置条件→操作→期望」三列，数量满足 2~3 条/类（code 3、knowledge 3、obsidian 4、document 4、控制台 3），且多数期望与 §2.3 错误码一致（C1↔L83、D1-D4↔L135-139、O1↔L107）；
- T8（L208）引用 §4.3；L298-303 给出 6 个 spec 文件名并映射到 C/K/O/D/U 用例号，第 2 轮「列明 spec 文件名」达成。

仍未闭合：

- **L304 的「mock 端点清单」名不副实**：原文说「全部用真实 RPC + 临时目录；不 mock 成功路径」，既没有列出任何 mock 端点，也没有给出故障注入方式。负向用例中至少 U3（RPC 错误）无法仅靠真实 RPC + 临时目录稳定构造；D4（转换失败）若依赖「找一个必然失败的坏文件」也未给出构造口径。T8 仍可在「真错误 vs mock 注入」之间自由发挥，恰是第 2 轮要求列清单要消除的歧义。
- **建议改法**：把 L304 改成两种口径之一：
  1. 「mock/故障注入清单：`obsidian/generate`（注入指纹失败→`internal`）、`obsidian/generate`（注入不可合并→`conflict_detected`）、`document/convert`（注入转换异常→`document_conversion_failed`）、`code/graph`（注入宿主 RPC 失败→U3）；其余 C/D/K/O/U 场景全部用真实 RPC + 临时目录，不 mock 成功路径」；
  2. 若坚持零 mock，则逐条写明 U3、D4 的真实构造步骤（如何制造服务端 RPC 错误、如何准备确定失败的输入），并声明 e2e 禁止任何 mock。

同项顺带发现（不新增门禁，建议第 4 轮顺手修）：

- doc09 L28 仍写「`pnpm code:scan` 已可用，但需按 P0-6 补 `flows build`」，而 `package.json` 现状已含 `flows build`（第 2 轮实测通过）——事实陈旧，会误导 T1；
- C2（L259）期望 `invalid_argument`，但 code/* 错误码 L83 只有 `configuration_error`/`graph_execution_failed`/`internal`，未定义「节点不存在」的码；建议在 L83 补「节点不存在→`invalid_argument`（或约定返回明确的 not-found 文本）」；
- L1 标题仍是「第 2 轮修订版」，与 L3「待 QA 第 3 轮审核」不一致，建议改标题。

---

## 3. 质量结论与门禁

- **第 3 轮结论：不通过。**
- 已闭合：P0-2（CLI/错误码/边界）、P0-3（document 错误码）、P0-6 的负向用例表与 spec 文件名清单。
- 未闭合（阻塞第 4 轮放行）：
  1. P0-5：T-INT 的 `rpc.ts`/`query-service.ts` 组装接线与所有权表冲突，必须二选一修订（见 §2）；
  2. P0-6：L304 没有真正的 mock/故障注入端点清单，U3/D4 的失败构造口径缺失。
- **第 4 轮只审上述 2 项增量**（外加同项顺带发现的 3 处文字/一致性修正，不展开新议题），不放行其他新范围。
