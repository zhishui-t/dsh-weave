# T8 端到端测试报告（doc/09 §4.3）

> 测试人：测试工程师 1（tester-1）
> 日期：2026-08-29（会话执行环境）
> 结论：**不通过（16 passed / 4 failed），失败集中在 document/* 负向用例 D1-D4**
> 范围：graph-positive / graph-negative / knowledge-graph / obsidian / document-convert / console-pages

---

## 1. 运行方式与结论

```bash
pnpm build
pnpm exec playwright test \
  e2e/graph-positive.spec.ts \
  e2e/graph-negative.spec.ts \
  e2e/knowledge-graph.spec.ts \
  e2e/obsidian.spec.ts \
  e2e/document-convert.spec.ts \
  e2e/console-pages.spec.ts
```

| Spec | 用例 | 结果 |
| --- | --- | --- |
| `graph-positive.spec.ts` | code:scan→graph→path→explain→affected/flows | ✅ 通过 |
| `graph-negative.spec.ts` | C1-C3 | ✅ 通过 |
| `knowledge-graph.spec.ts` | K1-K3 | ✅ 通过 |
| `obsidian.spec.ts` | O1-O4 + force 冲突 | ✅ 通过 |
| `document-convert.spec.ts` | 正向 CSV 转换 + D1-D4 | ❌ 正向通过，D1-D4 失败 |
| `console-pages.spec.ts` | U1-U3 | ✅ 通过 |

**测试环境**
- OS：Windows（Git Bash / pwsh）
- Node：v24.15.0
- Playwright：1.62.1，Chromium headless
- 构建产物：`pnpm build` 通过
- TypeScript：`pnpm typecheck` 通过
- ESLint：e2e 新增 6 个 spec 通过 `--quiet`

> 说明：console-pages 的 U2 使用 harness 对 `code/build` 延迟应答以验证“构建中不重复提交”UI 行为；但后端目前未发现 `code/build` RPC 实现（`rpc.ts` / `query-service.ts` 均无 `code/build` 路由），需单独跟踪。

---

## 2. 缺陷清单

### DEFECT-001 [P1] D1 非白名单扩展名错误码不符合文档

- **标题**：`document/convert` 遇到非白名单扩展名返回 `unsupported_file_type` 而非 `invalid_argument`
- **前置条件**：仓库当前实现（`document-converter.ts`）
- **复现步骤**：
  1. 调用 `WeaveQueryService.dispatch('document/convert', { file: 'malware.exe', filename: 'malware.exe' })`
  2. 捕获异常
- **期望结果**：doc/09 §2.3/§4.2 要求错误码 `invalid_argument`
- **实际结果**：`WeaveError.code='unsupported_file_type'`
- **严重程度**：P1（错误契约不一致，UI/调用方按 `invalid_argument` 分支处理时会失效）
- **环境信息**：node v24.15.0，Windows

### DEFECT-002 [P1] D2 未实现 50MB 文件大小上限校验

- **标题**：`document/convert` 未对超过 50MB 的文件做拒绝，而是直接进入转换管线
- **前置条件**：`document-converter.ts` 无大小检查
- **复现步骤**：
  1. 创建 `big.pdf`（50MB + 1 字节）
  2. 调用 `document/convert` 提交该文件
  3. 观察转换器是否被调用
- **期望结果**：提交时报 `invalid_argument`
- **实际结果**：转换器被调用（`mock.calls.length=1`），未做大小校验
- **严重程度**：P1（资源消耗/DoS 风险，且违反文档明确约束）
- **环境信息**：node v24.15.0，Windows

### DEFECT-003 [P1] D3 jobId 不存在错误码不符合文档

- **标题**：`document/status` 对不存在的 jobId 返回 `job_not_found` 而非 `configuration_error`
- **前置条件**：当前 `DocumentConverter.status` 实现
- **复现步骤**：
  1. 调用 `query.dispatch('document/status', { jobId: 'doc_missing' })`
  2. 捕获异常
- **期望结果**：doc/09 §2.3/§4.2 要求 `configuration_error`
- **实际结果**：`WeaveError.code='job_not_found'`
- **严重程度**：P1（调用方按配置错误处理时语义不匹配）
- **环境信息**：node v24.15.0，Windows

### DEFECT-004 [P1] D4 转换失败未按文档暴露 `document_conversion_failed`

- **标题**：`document/status` 对失败任务只返回 `{status:'failed', error}`，不会抛 `document_conversion_failed` 错误码
- **前置条件**：转换器抛出异常（本测试用注入的 BombConverter 构造 D4）
- **复现步骤**：
  1. 提交一个注定转换失败的文档
  2. 轮询 `document/status` 直到 `failed`
  3. 再次调用 `document/status`
- **期望结果**：文档要求 `document_conversion_failed` 错误码 + error 信息
- **实际结果**：`document/status` 正常返回 `{jobId, status:'failed', error:'...'}`，没有错误码；只有 CLI/MCP `document convert` 路径使用 `conversion_failed`
- **严重程度**：P1（服务端状态机与 RPC 契约不一致，前端/其他调用方无法按错误码决策）
- **环境信息**：node v24.15.0，Windows

### DEFECT-005 [P2] 控制台“构建 / 刷新图谱”按钮依赖的 `code/build` RPC 缺失

- **标题**：`code/build` 后端路由未实现，UI 构建按钮实际会得到 no-mock/错误
- **前置条件**：`src/client/index.ts` 调用 `rpc('code/build', {})`；`rpc.ts` / `query-service.ts` 无 `code/build` 路由
- **复现步骤**：
  1. 打开代码图谱页
  2. 点击“构建 / 刷新图谱”
- **期望结果**：执行 `code:scan`（或服务端 build）并刷新摘要
- **实际结果**：`rpc('code/build')` 无对应端点 / no-mock 错误
- **严重程度**：P2（正向 UI 功能不可用；本 e2e U2 用 harness 暂测 UI 行为，未覆盖真实后端）
- **环境信息**：node v24.15.0，Windows

### DEFECT-006 [P3] GraphService 路径/解释对“节点 id”与“label”输入不一致

- **标题**：`code/path`/`code/explain` 接受 label（如 `alpha`），不接受 node id（如 `a_alpha`），且 C2 missing 返回文本“No node matching”而非错误码
- **前置条件**：Graphify CLI 行为（explain 对不存在节点返回文本，exit 0）
- **复现步骤**：
  1. 构建临时项目
  2. `code/path { source:'a_alpha', target:'a_beta' }` → `graph_execution_failed`
  3. `code/explain { node:'alpha' }` → 成功
  4. `code/explain { node:'definitely-not-exist' }` → 返回 `No node matching 'definitely-not-exist' found.`
- **期望结果**：按文档 C2 允许“明确未找到节点”文本，当前文本可接受；但 node id 输入不统一可能造成 API 使用困惑
- **实际结果**：C2 通过（文本明确），node id 输入会失败为 `graph_execution_failed`
- **严重程度**：P3（文档未强制，但建议统一入参；不作为本轮门禁）
- **环境信息**：node v24.15.0，Windows

---

## 3. 覆盖率小结

- graph：正向 C0（scan/graph/path/explain/affected/flows）通过；负向 C1-C3 通过。
- knowledge：K1 空图回退、K2 无命中空文本、K3 生命周期过滤通过。
- obsidian：O1 自动创建、O2 用户修改冲突、O2/force conflict_detected、O3 tombstone、O4 二进制不覆盖通过。
- document：正向 CSV 真实转换通过；D1-D4 失败（见缺陷）。
- console：U1 空态、U2 构建中禁止重复提交、U3 RPC 错误提示通过。

---

## 4. 建议

1. 修 4 个 document 负向契约问题（DEFECT-001~004）后重跑 `document-convert.spec.ts`。
2. 补齐 `code/build` 后端 RPC 并做真实 UI 验证。
3. 若文档保持“非白名单扩展名 → invalid_argument”，需在 `DocumentConverter` 或 QueryService 做错误码归一。
4. 完成缺失项后面向全量回归：`pnpm test:e2e`。
