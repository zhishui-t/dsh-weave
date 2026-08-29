# QA 审核报告：doc/09-图谱全量实施设计.md（第 2 轮）

> 审核人：qa（ds梁子）
> 审核对象：`doc/09-图谱全量实施设计.md`（第 2 轮修订版）
> 上一轮结论：`doc/review-report-09-round1.md`（P0-1~P0-6 不通过）
> 结论：**不通过（P0-2 / P0-5 未闭合，P0-3 / P0-6 残留缺口，进入第 3 轮）**
> 审核原则：只核对第 1 轮 P0-1~P0-6 的 6 项放行条件是否闭合；增量审核，不扩散。

---

## 1. 本轮实际核对的事实

| 核对点 | 证据 | 结论 |
| --- | --- | --- |
| 知识图谱 Graphify 模块/任务/RPC | doc09 L41、L84-94、L177、L183：`knowledge-graph.ts`、`knowledge/*` 契约、T-KG、T4/T5 依赖 | P0-1 已闭合 |
| Obsidian RPC/冲突矩阵/CLI | doc09 L47-48、L96-103、L141-156、L178 | RPC 与冲突矩阵已补，CLI 文件/命令与错误码未补（P0-2 未闭合） |
| AnyDoc 独立转换契约 | doc09 L43-46、L105-118、L179 | 传输/返回/存储/安全已定，document/* 失败错误码未定（P0-3 残留 1 项） |
| DAG 依赖边 | doc09 L172-185 | P0-4 已闭合 |
| 文件所有权 | doc09 L175-176 vs L191-196 | code/* RPC 任务角色与文件 owner 矛盾（P0-5 未闭合） |
| `code:scan` 脚本 | `package.json` L39：`graphify extract ... && graphify flows build --graph .graphify/graph.json` | 脚本已修正 |
| `code:scan` 实际执行 | 本轮执行 `pnpm code:scan`：exit 0，`.graphify/graph.json`（1269 nodes / 2595 edges / 68 communities）与 `.graphify/flows.json`（93 flows）均生成 | 第 1 条验收可执行，P0-6 的脚本侧闭合 |
| §4 负向用例与 T8 内容 | doc09 L206-215、L184 | 负向用例颗粒度未达第 1 轮要求（P0-6 未完全闭合） |

---

## 2. P0 逐项核对结论

### P0-1 知识图谱 Graphify 任务/模块/RPC —— ✅ 已闭合

- L41 新增 `knowledge-graph.ts` 模块落点；
- L84-94 给出 `knowledge/build|graph|query|path|explain` 入参/返回，并声明映射现有 `KnowledgeGraphResult`；
- L94 明确保留 candidate/active/deprecated/superseded 过滤与 approve/reject 生命周期；
- L177 新增 T-KG 任务（developer-2，依赖 T2）；L183 T5 依赖 T-KG，知识图谱前端替换有人接。
- 结论：第 1 轮放行条件 1 达成。

### P0-2 Obsidian RPC/CLI/同步契约 —— ❌ 未闭合

已补：
- L96-103 `obsidian/generate|open|reindex|status` 入参/返回；
- L141-156 默认路径、同步方向、5 场景冲突矩阵、frontmatter 规范、指纹存储位置。

仍缺（均为第 1 轮 P0-2 明确要求）：
1. **CLI 无落点与命令**：L47-48 只有 `obsidian-service.ts`，没有 `obsidian/cli.ts`；L178 T3 内容写了 `RPC/CLI`，但全文档没有 `/weave obsidian ...` 命令与文件落点，T3 实现仍可自由发挥。
2. **obsidian/* 无错误码**：第 1 轮要求「逐项给入参/返回/错误码」，现只给了入参/返回。
3. **场景缺口**：重命名、二进制附件、增量刷新（非首次）未定义；用户删除、首次生成已补。

- 影响：T5 联调缺少 CLI 口径，T8 无法验收 CLI 与上述边界分支。
- 建议改法：§2.1 增加 `src/plugins/weave/obsidian/cli.ts`；§2.3 的 obsidian 表后补错误码（如 vault 不存在→`configuration_error`、指纹/同步失败→`internal` 等）；§2.6 补「重命名」「二进制附件」「增量刷新」三行策略。

### P0-3 AnyDoc 独立转换契约 —— ⚠️ 基本闭合，残留 1 项

已补：
- L105-111：`document/convert` 双模式入参（base64+filename / path）、统一返回 `{ jobId, status }`；preview/status 返回对象契约；
- L113-118：复用 `AnyDocConverterAdapter` + 白名单、独立 job 存储 `state_dir/convert-jobs.json`、控制台/CLI 传输分工、50MB 上限、UTF-8、路径授权目录限制。

仍缺：
- **document/* 失败错误码未定**：`document/status` 只有 `error?` 字段，没有 code 映射（对比 code/* 在 L82 有明确错误码）；第 1 轮 P0-3 建议改法含「失败错误码」，未闭合。

- 建议改法：在 L105-118 补一行错误码（如超白名单→`invalid_argument`、超大小/解码失败→`invalid_argument`、转换失败→`document_conversion_failed` 或 `internal`、job 不存在→`configuration_error`）。

### P0-4 任务 DAG 缺边与串行 —— ✅ 已闭合

- T4 依赖 T-INT、T7；T-INT 依赖 T1/T2/T-KG/T3/T6，文档转换与知识图谱后端依赖已闭合；
- T5 依赖 T4、T3、T-KG、T6，且 L183 注明同 `frontend-1` 串行；
- T6 依赖 T1，显式串行；
- T7 输出路径明确（L181 `doc/10-...md`），并作为 T4 依赖。
- 结论：第 1 轮放行条件 4 达成。

### P0-5 文件所有权唯一化 —— ❌ 未闭合（新增一处自相矛盾）

已补：`convert/**`→developer-1、`obsidian/**`→developer-3、`host-wiring.ts` 三段分 owner、`index.ts`→T-INT、`graph-tools.ts` 已说明是 host-wiring 消费的纯回调定义文件。

残留矛盾：
1. **`code/*` RPC 的角色与 owner 冲突**：L175 T1 由 `developer-1` 实现 `GraphService 接入 RPC：code/*`；但 L195 `rpc.ts` code/knowledge/document/obsidian 段「对应上述 owner」中，code 对应的是 graph 行（L191 developer-2）、knowledge 对应 L192 developer-2。即 code 段的唯一 owner 是 developer-2，而实现任务 T1 是 developer-1，T1 无权写自己交付物所在的 `rpc.ts` code 段；L196 `query-service.ts` 对应段同此矛盾。
2. **`graph-service.build()` 改造无人认领**：L60 要求 `build()` 改为 `extract + flows build`，但 T1 内容不含改 graph-service.ts 且不拥有该文件，T2 拥有该文件但内容只有 `weave_graph_*` 工具 + `graph-tools.ts`。

- 影响：按现状派发，code/* RPC 的第一实现人与文件 owner 立即冲突；build() 改造会成为无人负责的空隙。
- 建议改法：L195/L196 拆成四行明确 owner——`rpc.ts`/`query-service.ts` 的 `code` 段 = developer-1（T1）、`knowledge` 段 = developer-2（T-KG）、`document` 段 = developer-1（T6）、`obsidian` 段 = developer-3（T3）；同时把 `graph-service.ts` 的 build() 改造明确归给 T1（并给 T1 该文件段所有权）或归给 T2（并把该项写入 T2 内容、T1 增加对 T2 的依赖）。

### P0-6 验收标准与可执行命令一致 —— ⚠️ 部分闭合

脚本侧已闭合：
- `package.json` L39 已改为 `extract && flows build`；本轮实测 `pnpm code:scan` exit 0，`.graphify/graph.json` 与 `.graphify/flows.json` 均生成，§4 第 1 条可执行。

负向用例侧未闭合：
- 第 1 轮要求「§4 每类能力补『前置条件→操作→期望』2~3 条关键负向用例」；现 L208-215 仍是一句一验收项，无前置条件/操作/期望结构，且每类能力最多 1 条负向描述（如 document 只有「超白名单扩展名被拒」，code 只有「未构建返回 configuration_error」），未达 2~3 条。
- 第 1 轮要求「T8 列明 e2e spec 文件名与 mock 端点清单」；L184 T8 内容仍为「端到端测试 + 负向用例」一句，未落文件名/端点。

- 建议改法：§4 改为按 code/knowledge/obsidian/document 分组，每组 2~3 条「前置条件→操作→期望」负向用例（未构建、无匹配 node、affected 空数组、超白名单/超大小、冲突三分支、job 不存在、超时/取消）；T8 内容写明 spec 文件（如 `e2e/graph-negative.spec.ts` 等）与 mock 端点清单。

---

## 3. 质量结论与门禁

- **第 2 轮结论：不通过。**
- 已闭合：P0-1、P0-4；P0-6 的脚本侧。
- 未闭合（阻塞第 3 轮放行）：
  1. P0-2：obsidian CLI 落点/命令 + 错误码 + 重命名/二进制/增量刷新场景；
  2. P0-3：document/* 失败错误码；
  3. P0-5：rpc.ts/query-service.ts 的 code 段 owner 与 T1 角色对齐，并认领 `graph-service.build()` 改造；
  4. P0-6：§4 按能力分组补 2~3 条「前置条件→操作→期望」负向用例，T8 列明 spec 文件名与 mock 端点。
- **第 3 轮只审上述 4 项增量**，不展开新议题。
