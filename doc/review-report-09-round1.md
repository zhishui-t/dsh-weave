# QA 审核报告：doc/09-图谱全量实施设计.md（第 1 轮）

> 审核人：qa（ds梁子）
> 审核对象：`doc/09-图谱全量实施设计.md`
> 基线：`doc/08-图谱与独立能力完整版设计.md`
> 结论：**不通过（需修订后进入第 2 轮）**
> 审核原则：只审「模块划分 / RPC·工具·UI 契约 / 任务依赖 / 文件所有权」四类可实施性问题，不扩散。

---

## 1. 审核证据（本轮实际核对过的事实）

| 核对点 | 证据 | 结论 |
| --- | --- | --- |
| GraphService 2.2 接口 | `src/plugins/weave/graph/graph-service.ts`（build/query/path/explain/affectedFlows/listFlows/getFlow/hasGraph 齐全）；对照 `@sentropic/graphify@0.17.1` CLI help，`--budget/--dfs/--files/--json/flows list/get` 参数均存在 | 2.2 与现状一致，可用 |
| RPC 路由现状 | `src/plugins/weave/rpc.ts` 只把 `task/`、`knowledge/`、`audit/`、`session/` 前缀转发 `WeaveQueryService.dispatch`；`code/*`、`document/*` 不在路由内，会落入「未知 RPC endpoint」 | doc09 未交代此路由改动 |
| AnyDoc 现状 | `src/plugins/weave/import-pipeline.ts` 已有 `AnyDocConverterAdapter` + 白名单 + upload→convert→preview 状态机；`@firecrawl/anydoc@0.2.3` 已安装 | 新 `convert/document-converter.ts` 与现有管线关系未定义 |
| 工具注册现状 | `src/plugins/weave/host-wiring.ts` `buildWeaveToolDefinitions` 现为 15 个团队/任务/知识工具，无 `weave_graph_*`、`weave_document_convert` | 2.4 契约需要新增，但 owner 与落点有矛盾（见 P0-5） |
| UI 现状 | `src/client/index.ts` 路由只有 overview/teams/knowledge/executors/audit/settings/manual；知识图谱为 `knowledge/graph` 双链预览；Obsidian 只有打开/复制路径 | 2.5 的三块改动量明确，但缺 RPC 契约与设计稿依赖 |
| 团队角色 | `~/.dsh/teams/ds-liangzi.yaml` 存在 `developer-1/2/3`、`frontend-1`、`ui-designer`、`tester-1`、`qa`，且各角色 `max_concurrent_tasks: 1` | DAG 角色名可派发，但并发/串行约束未反映到 DAG |
| 验收第 1 条 | `package.json` `code:scan` 只有 `graphify extract src --out . --no-description --no-label`，**没有 `flows build`** | 与「code:scan 生成 graph.json 与 flows.json」的验收标准矛盾 |
| 基线健康 | `pnpm typecheck` 全绿（仅作当前基线记录） | — |

---

## 2. P0 阻塞项（必须先修订，否则不可派发）

### P0-1 知识图谱「替换为 Graphify」没有任务、模块和 RPC 契约

- **位置**：doc09 §2.1 / §2.3 / §2.4 / §3.2 全表
- **问题**：文档把「知识图谱替换为 Graphify 结果」写进了 §2.5 UI 和 §4 验收，但：
  - §2.1 只有 `src/plugins/weave/graph/**`（项目代码图谱）和 `src/client/index.ts` 一条「知识图谱页替换」，没有任何知识图谱 Graphify 构建/查询模块落点；
  - §2.3 的 RPC 全部是 `code/*`，没有 Graphify 版 `knowledge/graph`（以及文档 §5.4 承诺的 query/path/explain）的入参/返回契约；
  - §3.2 DAG **没有任何任务负责知识图谱后端实现**（T1 是代码图谱，T4 是前端页）。
- **影响**：T4 前端只能继续调旧的双链 `knowledge/graph`，验收项「知识图谱页替换为 Graphify 结果」无人交付；T8 无法测试。
- **建议改法**：
  1. 新增任务 T-KG（建议 `developer-1`，依赖 D-QA/T1）：用 Graphify 对 `~/.dsh/knowledge` 构建知识图谱（数据落点、构建触发、与 `[[双链]]` 旧实现的兼容/下线策略）；
  2. 在 §2.3 明确 `knowledge/graph` 的 Graphify 响应 schema（nodes/links/communities 与现有 `KnowledgeGraphResult` 的映射），以及可选 `knowledge/query|path|explain`；
  3. T4 依赖增加 T-KG；§4 验收同步细化。

### P0-2 Obsidian 完整能力的 RPC/CLI/同步契约缺失

- **位置**：doc09 §2.1 / §2.3 / §2.5 / §3.2-T3
- **问题**：T3 明确要交付「生成/打开/回索引/冲突保护 + RPC/CLI」，但：
  - §2.3 RPC 表完全没有 `obsidian/*` 端点；
  - §2.1 只有 `obsidian-service.ts` 一个文件，CLI 入口未落点；
  - §2.6 的冲突策略只有一句「对比文件指纹；外部修改时间/内容优先」，没有定义：Vault 与 `~/.dsh/knowledge` 的同步方向、文件→知识条目（id/layer/status）映射、frontmatter 规范、删除/重命名/二进制附件/首次生成与增量刷新场景、指纹存哪里。
- **影响**：T5（前端接入）没有可联调的端点，T3 实现必然自由发挥，T8 的「外部修改不覆盖」无验收口径。
- **建议改法**：§2.3 增加至少 `obsidian/generate`、`obsidian/open`（或前端仅拼 `obsidian://open`）、`obsidian/reindex`、`obsidian/status`，逐项给入参/返回/错误码；§2.6 补一张冲突矩阵（Weave 更新 vs 用户修改 vs 双方修改 vs 用户删除）；T3 内容明确 `/weave obsidian ...` CLI 与文件落点。

### P0-3 AnyDoc 独立转换契约未定义，且与现有 ImportPipeline 关系不明

- **位置**：doc09 §2.1 / §2.3 / §2.6；对照 `src/plugins/weave/import-pipeline.ts`
- **问题**：
  - 现状已有 `ImportPipeline`（AnyDoc 适配器 + 扩展名白名单 + upload→convert→preview + imports.db 状态机）。新 `convert/document-converter.ts` 是复用、抽取还是重写？不写清楚会产出第二套转换状态机。
  - `document/convert` 入参 `file` 语义不明：是服务端绝对路径、base64、还是引用 `knowledge/import/upload` 的 jobId？控制台浏览器场景和 CLI 场景传输方式不同，当前契约无法实现。
  - 返回写「转换结果 / jobId」是二义 union；`document/preview` 返回 Markdown 还是对象也未定（现有 RPC 注释约定 value 应为 object）。
  - 2.6 的缓存目录 `~/.dsh/imports 或 state_dir` 与现有 `ImportPipeline` 构造参数、`query-service.importUpload` 写死 `~/.dsh/imports` 的现状不一致。
- **影响**：T6 与 T4（文档转换页）无法并行/联调；与知识导入路径存在重复或数据分叉风险。
- **建议改法**：明确「独立转换 = 复用 `AnyDocConverterAdapter` + `WHITELIST_EXTENSIONS`，新建独立 job 存储（或明确复用 imports.db 但不要求 ImportMeta）」；定 `document/convert` 为上传式（base64 + filename）与服务端路径式二选一（控制台用前者、CLI 用后者），统一返回 `{ jobId, status }`；`document/preview` 返回 `{ markdown, title, warnings }`；补大小限制、编码、扩展名拒绝、失败错误码。

### P0-4 任务 DAG 存在缺边与同人同文件未串行

- **位置**：doc09 §3.2
- **问题**：
  1. T4「控制台代码图谱页 + **文档转换页接入 RPC**」依赖只有 T1、T2；文档转换 RPC 在 T6，缺 T4→T6 边（若 T6 未完成，T4 直接编译/联调失败）。
  2. T4、T5 都改 `src/client/index.ts` 且同属 `frontend-1`（该角色 `max_concurrent_tasks: 1`），但两任务之间无依赖，调度顺序未定，同一文件按什么顺序合并不明确。
  3. T7（UI 设计稿）不是 T4/T5 的依赖：前端可能在设计稿产出前按 §2.5 三行文字自行实现，设计稿失去作用。
  4. T6 与 T1 同属 `developer-1`，但 T6 只依赖 D-QA；`max_concurrent_tasks: 1` 下注释写「如 T1 已完成可并行/追加」与实际串行语义矛盾，应显式 `T6 depends_on T1`。
- **影响**：依赖不闭合导致开发阻塞、返工；同文件合并顺序不确定会制造冲突。
- **建议改法**：T4 依赖 = `T1、T2、T6、T-KG、T7`；T5 依赖 = `T3、T7`，并加 `T5 depends_on T4`（或反向，只要显式串行）；T6 依赖 = `T1`；T7 输出明确设计稿文件路径（如 `doc/09-ui-spec-*.md`）。

### P0-5 文件所有权互相矛盾，且缺关键接线文件 owner

- **位置**：doc09 §3.3，对照 §2.1/§3.2
- **问题**：
  1. `convert/**` 所有权给了 `developer-3`，但 AnyDoc 转换任务 T6 分配给 `developer-1`；developer-3 的 T3 内容不含 convert。按所有权规则 T6 无权写自己交付物的主目录。
  2. `weave_document_convert` 出现在 §2.4，但 T2 内容只有 `weave_graph_*`；T6 只写「服务 + RPC/CLI」，没写工具接入。`host-wiring.ts` 的 graph/doc 工具段归 developer-2，具体谁改哪段无定论。
  3. `document/*` 端点要同时改 `rpc.ts`（当前不转发 code/document）与 `web/query-service.ts`；这两文件的 doc 段没有任何 owner（developer-1 只拥有 graph 段）。
  4. `src/plugins/weave/index.ts` 需要把 GraphService/ObsidianService/DocumentConverter 组装进 RPC/工具/服务挂载，但**没有任务或 owner 认领该接线**。
  5. §2.1 列了 `graph-tools.ts`，而现有架构的工具注册集中在 `host-wiring.ts`；两处落点并存未说明关系。
- **影响**：按现状派发必然互相改同一文件或无人改接线文件，T8 集成会卡在组装层。
- **建议改法**：按「文件→唯一 owner」重排：
  - `convert/**` 与 `document-converter/cli/mcp` → `developer-1`（T6）；`obsidian/**` → `developer-3`（T3）；
  - `rpc.ts`：graph 段 developer-1、document 段 developer-1、obsidian 段 developer-3；
  - `query-service.ts`：同上按段；
  - `host-wiring.ts`：graph 工具段 developer-2，`weave_document_convert` 段 developer-1（或明确并入 T2 后只给 developer-2）；
  - `index.ts` 接线：新增 T-INT（或明确归 developer-2/T2 追加），列出组装点；
  - 删除 `graph-tools.ts` 或说明它是 host-wiring 消费的纯回调定义文件，避免双实现。

### P0-6 验收标准与现状可执行命令不一致，且缺可测场景

- **位置**：doc09 §4；对照 `package.json#scripts.code:scan`
- **问题**：
  1. §4 第 1 条要求 `pnpm code:scan` 生成 `.graphify/graph.json` **与 `.graphify/flows.json`**；脚本实际只有 extract，不生成 flows.json。要么把脚本改为 `extract ... && graphify flows build`，要么把 flows 产物移出该条验收。
  2. §4 的验收全是正向 happy path：未构建时 `code/graph` 的行为、无匹配 node、`affected` 空数组、转换不支持的扩展名、Obsidian 冲突三种分支、超时/取消，都没有验收项；T8 的测试内容只写了一句粗粒度场景。
- **影响**：验收不可执行/可被空实现糊过。
- **建议改法**：修正脚本或验收口径；§4 每类能力补「前置条件→操作→期望」2~3 条关键负向用例；T8 列明 e2e spec 文件名与 mock 端点清单。

---

## 3. P1 建议（可同轮修订，不阻塞第 2 轮派发）

1. **RPC 路由改动写进设计**：`rpc.ts` 前缀路由需增加 `code/`、`document/`（如 Obsidian 也走 RPC 则加 `obsidian/`），并同步 `WeaveQueryService.dispatch`；这是 P0-5 的落点细节。
2. **控制台需要构建入口**：§2.3 没有 `code/build`，§2.5 也没有构建/刷新按钮；首次未构建时页面空态无法自愈。建议明确「首次查询自动 build」或加 `code/build` RPC，否则控制台页验收只能依赖手动 `pnpm code:scan`。
3. **GraphService 运行期健壮性**：`#run` 无超时/AbortSignal，JSON.parse 失败直接抛原始错。T1 应定错误映射：图未构建→`configuration_error`、CLI 非零退出→`graph_execution_failed`、解析失败→`internal`；构建类调用给超时上限（如 10min）并接 RPC signal。
4. **文档转换安全面**：`document/convert` 的服务端路径模式必须限定目录与扩展名白名单，禁止任意文件读取；沿用 TDD 3.1.2/3.1.3 的宏不执行、大小限制、UTF-8 约定。
5. **UI 自验证据**：T4/T5/T7 的 UI 交付应附带 Playwright 无头自验截图（真实页面 boundingBox/pageerror），并新增对应 e2e harness mock 端点；否则 T9 只能验编译，验不了页面。
6. **知识图谱数据与审核生命周期**：Graphify 结果渲染后，仍需保留 candidate/active/deprecated/superseded 状态过滤与 approve/reject 入口；设计稿 T7 必须覆盖该约束，避免替换时把审核流程一起换掉。
7. **doc08 的遗留口径**：ZCode Graphify MCP 配置、`THIRD_PARTY_NOTICES.md` 未在 doc09 承接；若仍属全量交付范围，补一行归属（T2/T9），否则明确移出本轮范围。

---

## 4. 质量结论与门禁

- **第 1 轮结论：不通过。** P0-1~P0-6 属于「契约不完整 / 依赖不闭合 / 所有权冲突」三类可实施性阻塞，按现状派发会直接产生返工与文件冲突。
- **放行条件（第 2 轮只核对以下增量）**：
  1. 知识图谱 Graphify 任务 + RPC/UI 契约补齐；
  2. Obsidian RPC/CLI/冲突矩阵补齐；
  3. AnyDoc 复用/独立方案与 document/* 传输/返回契约定稿；
  4. DAG 补边（T4→T6/T7、T5→T4/T7、T6→T1）且知识图谱任务入表；
  5. 文件所有权唯一化（convert/**、rpc/query-service/host-wiring 各段、index.ts 接线）；
  6. `code:scan` 脚本与验收标准一致，§4 补负向用例。
- 上述 6 项修订完成后，QA 第 2 轮只审修订 diff 与对应源文件，不再展开新议题。
