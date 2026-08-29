# UI 设计稿：代码图谱 / 知识图谱 / 文档转换 / Obsidian 控制台

> 版本：v1.0（设计稿，未落码）
> 角色：ui-designer（ds梁子）
> 日期：2026-08-29
> 目标文件：`src/client/index.ts`（延续单文件、`React.createElement` 风格，禁止新增 import 破 bundle）
> 供实现：`frontend-1`（T4 代码图谱 + 文档转换页；T5 Obsidian 页 + 知识图谱页升级）
> 上游依赖：`doc/09-图谱全量实施设计.md`（等待 QA 第 2 轮修订）、`doc/08-图谱与独立能力完整版设计.md`
> 原则：复用现有 `.weave-*` 样式与 `--dsw-*` token；不引入 UI 框架；先给明确信息架构，再给组件与状态。

---

## 0. 范围与目标

本设计覆盖四项控制台能力：

1. **代码图谱页**：展示 Graphify 项目图谱摘要、提供查询 / 路径 / 解释 / 影响面 / 执行流工具。
2. **知识库页升级**：保留知识生命周期（candidate→active/deprecated/superseded）与审核入口，将图谱区从“轻量双链预览”升级为 Graphify/统一图谱结果，并移除“完整 Graphify 属于后续版本”文案。
3. **文档转换页**：独立 AnyDoc 转换入口（文件→Markdown 预览 / 状态 / 历史），与知识导入解耦。
4. **Obsidian 控制台页**：Vault 路径与状态、生成/刷新、打开、回索引、冲突保护与冲突处置入口。

设计不替代后端接口实现；若后端契约按 QA 报告调整，前端应以本文“前端假定契约”为联调基线。

---

## 1. 设计约束与复用基线

### 1.1 硬约束

- 保持 `src/client/index.ts` 单文件；不能用 `import` 引入组件库。
- 继续使用既有 CSS 类：`.weave-page / .weave-panel / .weave-toolbar / .weave-control / .weave-button(-secondary/-small) / .weave-card / .weave-grid / .weave-list / .weave-list-item / .weave-list-head / .weave-empty / .weave-note / .weave-pill / .weave-dot / .weave-graph-wrap / .weave-graph-detail / .weave-code / .weave-muted / .weave-subh / .weave-actions`。
- 颜色只用 `--dsw-alias-*` / `--dsw-specific-*`；状态色沿用 `.weave-dot` 四色（run 蓝 `#1677ff` / good 绿 `#52c41a` / bad 红 `#f5222d` / idle 灰 `#8c8c8c`），警示用 `#faad14`。
- 新增 CSS 只允许“低实现成本、复用度高”的类（见 §3.3），禁止另起一套设计体系。
- 所有异步操作用现有 `useResource` / `useAction`；浮层复用 `ConfirmDialog`，不引入原生 confirm/prompt。

### 1.2 页面路由与导航

在 `type Route` 与 `ROUTES` 中新增：

| key | label | desc（侧栏 title/导航描述） |
|---|---|---|
| `code` | 代码图谱 | Graphify 项目结构、语义查询与影响面。 |
| `knowledge` | 知识库 | 知识审核、注入管理与知识图谱。 |
| `convert` | 文档转换 | AnyDoc 独立文档转 Markdown 与预览。 |
| `obsidian` | Obsidian | Vault 生成、打开、回索引与冲突保护。 |

建议导航顺序：总览 → 团队 → **代码图谱** → **知识库** → **文档转换** → **Obsidian** → 执行器 → 审计 → 设置 → 手册。

`WeaveDashboard.pages` 增加：

```ts
code: React.createElement(CodeGraphPage),
convert: React.createElement(DocumentConvertPage),
obsidian: React.createElement(ObsidianPage),
```

`knowledge` 继续指向升级后的 `KnowledgePage`（内部可将 Obsidian 旧面板替换为“前往 Obsidian 页”入口，避免双份能力）。

---

## 2. 总体信息架构

控制台采用“一页一主任务”的扁平结构。四个新增/升级页面分享相同外壳和工具条规范：

```
┌──────────────────────────────────────────────────────────────┐
│ 页面标题（h1）                                  [主操作] [次级操作] │
│ Note（加载中 / 成功 / 错误）                                     │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│ │ 数据概览卡    │ │ 数据概览卡    │ │ 数据概览卡    │  ← 需要时才出现 │
│ └─────────────┘ └─────────────┘ └─────────────┘               │
│ ── 功能区（可折叠/分步）──                                       │
│ 输入控件 + 操作按钮 → 结果面板（文本/列表/图）                       │
│ ── 列表/图谱区 ──                                               │
└──────────────────────────────────────────────────────────────┘
```

用户动线原则：

1. 页面打开先给“当前状态摘要”（有没有图谱 / Vault / 最近转换）。
2. 用户需要时再执行构建、转换、生成等长任务，操作期间提供进度与不可重复点击（busy）。
3. 结果区永远在被点击动作附近呈现，不把错误丢到页面顶部与操作点脱节。

---

## 3. 共享控件规范

### 3.1 数据摘要卡（MetricCard，复用 `.weave-card`）

结构：

```
[标题小字 muted]      ← 建议 label，非 b
[大数字/核心值]        ← 13-14px，font-weight 550
[补充说明 muted]
[可选状态 Pill]
```

所有摘要卡统一用 `.weave-grid`（`repeat(auto-fit,minmax(240px,1fr))`），不放长文本。

### 3.2 文本结果面板（TextResult / PlainResult）

用于 `code/path`、`code/explain`、`code/query`、`document/preview` 等返回纯文本/JSON 的结果。

- 容器：`.weave-panel` + `pre` 样式（`white-space:pre-wrap; word-break:break-word; max-height:420px; overflow:auto; font-family:var?` 用 `.weave-code`）。
- 顶部可带小型操作行：复制 / 收起 / 导出（可选）。
- 空结果给 `EmptyState`，不是空白面板。

### 3.3 新增低量 CSS（可选，只加这几条）

```css
.weave-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.weave-tab{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:5px 12px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
.weave-tab[data-active="true"]{background:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));color:var(--dsw-specific-menu);font-weight:550}
.weave-metric{display:grid;gap:2px}
.weave-metric b{font-size:16px;font-weight:600}
.weave-metric span{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.weave-progress{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.weave-progress i{display:block;height:100%;background:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));border-radius:999px;transition:width .2s}
.weave-text-result{max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;background:var(--dsw-specific-menu)}
```

---

## 4. 代码图谱页（CodeGraphPage）

### 4.1 页面布局

```
代码图谱
│  Note：加载/成功/错误
│  [构建 / 刷新图谱](主按钮)  [图谱路径(只读代码)]
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ 节点  1,177  │ │ 边  2,369    │ │ 社区  67     │ │ 执行流  87    │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
────────── 功能 Tabs：概览 | 语义查询 | 路径 | 解释 | 影响面 | 执行流 ──────────
┌────────────────────────────────────────────────────────────┐
│ 当前 Tab 的操作区 + 结果区                                   │
└────────────────────────────────────────────────────────────┘
```

说明：
- 概览 Tab 展示 `code/graph` 摘要、最近构建时间、commit 新鲜度、Graphify 报告中的“God Nodes / 边类型”摘要（如 RPC 可回传则展示，否则摘要卡即可）。
- 语义查询 / 路径 / 解释为文本结果面板；影响面为文件输入 + 影响流列表；执行流为可搜索列表 + 详情抽屉/展开。

### 4.2 组件分解

| 组件 | 职责 | 复用/新增 |
|---|---|---|
| `CodeGraphPage` | 持有摘要、tab、查询状态、busy 状态 | 复用 `.weave-page/.weave-toolbar` |
| `GraphSummary` | 四个 MetricCard | 复用 `.weave-card/.weave-grid` |
| `GraphToolTabs` | 概览/查询/路径/解释/影响面/执行流切换 | 新增 `.weave-tabs` |
| `GraphQueryTool` | question + budget + dfs + 执行按钮 → 文本结果 | 新增 |
| `GraphPathTool` | source + target → 文本结果 | 新增 |
| `GraphExplainTool` | node id → 文本结果 | 新增 |
| `GraphAffectedTool` | 文件列表 textarea/多行 → `AffectedFlowsResult` 渲染 | 新增 |
| `GraphFlowsList` | 执行流摘要列表；点击展开详情 | 复用 `.weave-list-item` |
| `GraphFlowDetail` | 流名称、入口、路径、文件、警告、关键性 | 新增（可复用 `.weave-list`） |

### 4.3 前端假定数据契约（联调基线）

> 后端 RPC 若与 doc09 修订后一致，则可直接使用；不一致时以本文为准并同步后端。

```ts
interface CodeGraphSummary {
  exists: boolean
  graphPath?: string
  nodes?: number
  edges?: number
  communities?: number
  flows?: number
  generatedAt?: string
  commit?: string
  headCommit?: string
  stale?: boolean
  edgeKinds?: Record<string, number>       // 可选
  godNodes?: Array<{ id: string; label: string; degree: number }> // 可选
}
```

RPC 端点与返回：

| 端点 | 入参 | 返回 | 前端用途 |
|---|---|---|---|
| `code/graph` | `{}` | `CodeGraphSummary` | 摘要卡、是否存在 |
| `code/build`（建议） | `{}` | `{ graphPath: string; flowsPath: string }` | 构建按钮 |
| `code/query` | `{ question: string; budget?: number; dfs?: boolean }` | `{ text: string }` | 查询结果 |
| `code/path` | `{ source: string; target: string }` | `{ text: string }` | 路径结果 |
| `code/explain` | `{ node: string }` | `{ text: string }` | 解释结果 |
| `code/affected` | `{ files: string[] }` | `AffectedFlowsResult` | 影响面列表 |
| `code/flows` | `{ limit?: number; search?: string }` | `GraphFlow[]` | 执行流列表 |
| `code/flows/get` | `{ id: string }` | `GraphFlow` | 流详情 |

> 若 `code/graph` 暂时只返回计数摘要，前端不得假定能渲染全部节点；可视化降级为“摘要 + 可查询/可解释”，不画 1177 节点全量 SVG（性能风险）。

### 4.4 状态表

| 场景 | 呈现 |
|---|---|
| 首次加载摘要 | `useResource` loading → Note「正在加载图谱摘要…」+ 4 张骨架卡（`.weave-card` 灰壳） |
| 尚未构建 / `exists=false` | 页面级 EmptyState：标题「尚未生成代码图谱」，正文说明 `pnpm code:scan` 或点「构建 / 刷新图谱」，主按钮引导构建 |
| 构建中 | 构建按钮 disabled 文案「构建中…」，显示 `weave-progress` 不定进度条（或用 Note + 轮询 `code/status`，若后端提供）；禁止并发点击 |
| 构建成功 | Note「图谱已更新：节点 N · 边 M · 社区 C」；摘要卡刷新；自动切到概览 |
| 构建失败 | Note(kind=error)，保留上次成功摘要；不自动删除旧图 |
| 查询/路径/解释为空 | 结果面板显示 EmptyState「未找到结果」，不是空白 |
| `affected` 无匹配 | 显示「没有匹配文件」，列 unmatchedFiles |
| 执行流为空 | EmptyState「暂无执行流，请先构建图谱」 |
| RPC 未接入 | 页面级 EmptyState/Note：`code/* 尚未接入 RPC`，与现有知识页风格一致 |

### 4.5 data-testid 锚点

| 锚点 | 说明 |
|---|---|
| `page-code` | 页面根 |
| `code-build` / `code-refresh` | 构建/刷新按钮 |
| `code-summary-nodes` / `code-summary-edges` / `code-summary-communities` / `code-summary-flows` | 摘要卡数值 |
| `code-tab-overview` / `code-tab-query` / `code-tab-path` / `code-tab-explain` / `code-tab-affected` / `code-tab-flows` | Tab |
| `code-query-input` / `code-query-submit` / `code-query-result` | 语义查询 |
| `code-path-source` / `code-path-target` / `code-path-submit` / `code-path-result` | 路径 |
| `code-explain-input` / `code-explain-submit` / `code-explain-result` | 解释 |
| `code-affected-files` / `code-affected-submit` / `code-affected-result` / `affected-flow-{id}` | 影响面 |
| `code-flow-{id}` / `code-flow-detail-{id}` | 执行流 |
| `code-empty` | 无图谱/无结果 |

### 4.6 交互与默认值

- **构建入口**：必须暴露在页面主操作，不能只靠 CLI。
- **查询默认值**：`budget` 默认 `20`，`dfs` 默认 `false`；下拉/checkbox 可调；仅在高级场景显示。
- **路径输入**：支持粘贴 node id，也用 Graphify 文本结果复制，不强制从图上选择节点。
- **影响面输入**：多行文本，每行一个相对路径；粘贴 git diff 文件名列表；空行忽略。
- **执行流列表**：默认按 `criticality` 降序、`nodeCount` 降序；搜索按 name/entryPoint/file 模糊匹配。
- **长文本**：结果面板统一 max-height + 内部滚动，页面不因此无限拉长。
- **错误重试**：构建失败提示建议重试；查询失败保留输入值，不清空。

---

## 5. 知识库页升级（KnowledgePage）

### 5.1 目标与保留项

- 保留：团队使用说明、候选/active 列表、状态/层级过滤、approve/reject 审核流、导入知识面板。
- 升级：图谱区从“双链预览”改为“知识图谱（Graphify 数据源）”，移除“完整 Graphify 查询属于后续版本”。
- Obsidian 旧面板改为“Obsidian 控制台入口卡片”，主功能移到独立 `obsidian` 页。

### 5.2 布局（变更说明）

```
知识库
│ 团队如何使用知识库（保留）
│ Note（加载中/错误）
│ [导入知识面板（保留）]
│ [前往 Obsidian 控制台]（原 Obsidian 面板缩略为入口卡）
┌ 知识图谱（升级）────────────────────────────────────────────┐
│ 标题：知识图谱（Graphify）                                     │
│ 筛选：状态 | 层级 | 项目                                        │
│ [图谱可视化/列表]  [右侧详情]                                   │
│ 摘要：共 N 条 · 缺失 M · 边 E · 社区 C                          │
└───────────────────────────────────────────────────────────┘
│ [知识列表 + 审核（保留）]
```

### 5.3 前端假定契约

优先复用现有 `KnowledgeGraphData` 形状，Graphify 版只需保持以下字段兼容：

```ts
interface KnowledgeGraphData {
  nodes: KnowledgeGraphNode[]
  edges: Array<{ source: string; target: string; relation?: string }>
  counts?: { knowledge?: number; missing?: number; edges?: number; communities?: number }
  projects?: string[]
  source?: 'double-link' | 'graphify'   // 可选，用于来源标识
}
interface KnowledgeGraphNode {
  id: string
  title: string
  kind: 'knowledge' | 'missing'
  status?: 'candidate' | 'active' | 'deprecated' | 'superseded'
  layer?: 'project' | 'role' | 'instance' | 'shared'
  tags?: string[]
  path?: string
  community?: string                    // Graphify 社区
  degree?: number                       // 可选，用于排序
}
```

### 5.4 控件与状态

| 控件 | 规范 |
|---|---|
| 图谱来源 Badge | 右上角 Pill：`Graphify` / `双链兼容`；若 `source` 缺失，默认显示「知识图谱」 |
| 状态筛选 | 保留 `knowledge-graph-status-filter` |
| 层级筛选 | 保留 `knowledge-graph-layer-filter` |
| 项目筛选 | 保留 `knowledge-graph-project-filter` |
| 节点详情 | 沿用 `KnowledgeGraphView.detail`；新增显示社区/关联度 |
| 空态/错误 | 沿用现有；Graphify 未构建时给出「可在代码图谱页构建」或「知识图谱数据源不可用」提示，但不得隐藏审核列表 |

### 5.5 关键边界

- **审核生命周期不能丢**：无论图谱数据源是否 Graphify，approve/reject 与候选列表必须始终可见。
- **大数据量**：如果 Graphify 知识节点 > 500，图谱区降级为“社区列表 + 搜索”，不全量 SVG；节点 ≤ 200 时用现有环形布局。
- **缺失目标**：`kind=missing` 节点保留，并可点击查看缺失原因/建议知识。

### 5.6 data-testid

保留现有 `page-knowledge`、`knowledge-import-panel`、`knowledge-graph`、`knowledge-node-*`、`knowledge-graph-detail`、`knowledge-*-filter`、`knowledge-item-*`、`knowledge-approve-*`、`knowledge-reject-*`。

新增：

| 锚点 | 说明 |
|---|---|
| `knowledge-graph-source-badge` | Graphify/双链来源 |
| `knowledge-graph-community-{id}` | 社区列表项（大数据量降级时） |
| `knowledge-obsidian-entry` | 前往 Obsidian 页入口 |

---

## 6. 文档转换页（DocumentConvertPage）

### 6.1 页面布局

```
文档转换
│  Note：加载/成功/错误
┌───────────────────────────────────────────────┐
│ 选择文件 [📄 拖拽/点击]  accept 列表             │
│ [支持格式说明 muted]  [清空]                   │
└───────────────────────────────────────────────┘
┌ 转换任务状态 ──────────────────────────────────┐
│ 文件名 · 状态（排队/转换中/完成/失败） · 耗时      │
│ [进度条（可选，如果 status 提供 progress）]       │
└───────────────────────────────────────────────┘
┌ Markdown 预览 ─────────────────────────────────┐
│ [复制 Markdown] [展开/收起] [作为知识导入（可选）] │
│ 预览内容 textarea/pre                           │
└───────────────────────────────────────────────┘
│ 最近转换历史列表                               │
```

### 6.2 前端假定契约

| 端点 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `document/convert` | `{ filename: string; data: string }`（控制台用 base64）或 `{ file: string }`（CLI/服务端路径） | `{ jobId: string; status: 'queued' | 'converting' | 'done' | 'failed' }` | 提交后立即返回 jobId |
| `document/status` | `{ jobId: string }` | `{ status; progress?: number; title?: string; warnings?: string[]; error?: string }` | 轮询 |
| `document/preview` | `{ jobId: string }` | `{ markdown: string; title?: string; warnings?: string[] }` | 获取最终 Markdown |
| `document/history`（建议） | `{ limit?: number }` | `Array<{ jobId; filename; status; createdAt; updatedAt; pages? }>` | 最近任务 |

> 上传/转换大小上限由后端返回错误；前端对选中的文件先做客户端扩展名白名单提示，不代替服务端校验。

### 6.3 组件分解

| 组件 | 说明 |
|---|---|
| `DocumentConvertPage` | 状态机：idle → uploading → converting → done / failed |
| `FileSelector` | 复用现有 `input[type=file] + .weave-control`；增加拖拽区可选 |
| `ConvertStatusCard` | 显示 job 状态、进度（有则显示）、错误 |
| `MarkdownPreview` | `<textarea>` 或 `<pre>`，默认可编辑预览；顶部复制按钮 |
| `ConvertHistory` | 最近任务列表，点击可重新打开预览 |
| `OptionalImportToKnowledge` | 完成转换后“生成知识候选”快捷按钮，直接跳转/调用知识导入确认（可复用 `KnowledgeImportPanel` 逻辑） |

### 6.4 状态表

| 状态 | 呈现 |
|---|---|
| 未选文件 | 文件选择器 + 空态提示「选择文档开始转换」 |
| 已选文件未提交 | 显示文件名、大小、目标格式（默认 Markdown） |
| uploading | busy，按钮禁用，提示「上传中…」 |
| converting | 轮询 `document/status`，显示进度/阶段；提供“取消”（若后端支持 cancel，否则禁用） |
| done | 显示 Markdown 预览、标题、warnings；提供复制/知识导入 |
| failed | Note(kind=error) 展示后端错误；保留表单与历史 |
| 不支持的扩展名 | 即时提示「不支持该格式」；不发起请求 |
| 历史为空 | EmptyState「暂无转换记录」 |

### 6.5 data-testid

| 锚点 | 说明 |
|---|---|
| `page-convert` | 页面根 |
| `convert-file` | 文件选择 |
| `convert-submit` | 开始转换 |
| `convert-clear` | 清空 |
| `convert-status` | 任务状态条 |
| `convert-preview` | Markdown 预览 |
| `convert-copy` | 复制 |
| `convert-history` / `convert-history-item-{jobId}` | 历史列表 |
| `convert-to-knowledge` | 转入知识候选（可选） |

### 6.6 交互与默认值

- **默认格式**：Markdown；不改用户上传文件，只输出转换文本。
- **轮询**：`document/status` 每 1.5s 一次，连续 3 次失败停止轮询并显示错误；完成后停止。
- **大文件**：预览默认只显示前 200KB + “显示全部”，避免 DOM 卡顿。
- **编码**：按 TDD 约定 UTF-8，预览显示乱码时不静默替换，给错误提示。
- **与知识导入解耦**：转换页不写知识库；只有用户主动点“作为知识导入”才走知识流程。

---

## 7. Obsidian 控制台页（ObsidianPage）

### 7.1 页面布局

```
Obsidian
│  Note：加载/生成中/错误
┌ Vault 信息 ─────────────────────────────────────────┐
│ 路径：~/.dsh/obsidian · 状态：已连接/未连接/未初始化   │
│ 文件数：N · 知识条目：N · 最近生成：xxx · 冲突：N      │
│ [打开 Obsidian] [复制路径] [重新索引] [生成/刷新 Vault] │
└──────────────────────────────────────────────────────┘
┌ 冲突保护 ───────────────────────────────────────────┐
│ 表：文件 | 外部修改时间 | Weave 上次生成 | 处置         │
│ 处置默认：保留外部（不覆盖）；可查看 diff/预览          │
└──────────────────────────────────────────────────────┘
┌ 最近同步记录（可选） ────────────────────────────────┐
```

### 7.2 前端假定契约

| 端点 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `obsidian/status` | `{}` | `{ vaultPath?: string; exists?: boolean; fileCount?: number; knowledgeCount?: number; lastGeneratedAt?: string; conflicts?: ObsidianConflict[]; error?: string }` | 页面打开时读取 |
| `obsidian/generate` | `{ force?: boolean }` | `{ jobId?: string; status: 'running' | 'done'; message?: string }` | 生成/刷新 Vault |
| `obsidian/reindex` | `{}` | `{ jobId?: string; status }` | 手动回索引 |
| `obsidian/conflicts` | `{}` | `{ conflicts: ObsidianConflict[] }` | 冲突列表 |
| `obsidian/resolve`（建议，P1） | `{ path: string; strategy: 'keep_external' | 'keep_weave' }` | 冲突处置结果 | 

```ts
interface ObsidianConflict {
  path: string
  externalModifiedAt?: string
  weaveGeneratedAt?: string
  summary?: string
  status: 'external_changed' | 'both_changed' | 'external_deleted'
}
```

### 7.3 组件分解

| 组件 | 说明 |
|---|---|
| `ObsidianPage` | 持有 status/conflicts/busy 状态 |
| `VaultStatusCard` | 路径、状态、文件数、冲突数 |
| `VaultActions` | 打开 / 复制 / 重新索引 / 生成刷新 |
| `ConflictList` | 冲突条目列表 + 默认处置策略 |
| `SyncLogList`（可选） | 最近生成/回索引记录 |

### 7.4 状态表

| 状态 | 呈现 |
|---|---|
| 未配置路径 | EmptyState「未配置 Obsidian Vault」+ 引导去设置页 |
| 路径不存在 | 状态卡显示「未初始化」；生成按钮可用，首次生成需要确认（ConfirmDialog） |
| 生成中 | 主按钮 disabled「生成中…」；显示 job 状态/进度；禁止重复点击 |
| 生成成功 | Note「已生成/刷新 Vault：N 个文件」；状态卡刷新 |
| 生成失败 | Note(kind=error)；保留旧状态；不覆盖已有 Vault |
| 有冲突 | 冲突数用琥珀色/红色 Pill；列表默认策略为“保留外部修改”，不自动覆盖 |
| 回索引中 | 按钮 disabled「回索引中…」 |
| 外部修改 | 冲突行显示“外部优先”，并提供“查看差异/保留外部”操作；如后端支持 `resolve`，才有“改为保留 Weave 生成内容”（需要 dangerous 确认） |

### 7.5 data-testid

| 锚点 | 说明 |
|---|---|
| `page-obsidian` | 页面根 |
| `obsidian-status` / `obsidian-vault-path` / `obsidian-file-count` / `obsidian-conflict-count` | 状态 |
| `obsidian-open` / `obsidian-copy` / `obsidian-generate` / `obsidian-reindex` | 动作 |
| `obsidian-conflict-{path}` / `obsidian-conflict-keep-external-{path}` / `obsidian-conflict-resolve-{path}` | 冲突 |
| `obsidian-generate-confirm` | 首次生成确认弹窗 |
| `obsidian-empty` / `obsidian-error` | 空/错误 |

### 7.6 交互与默认值

- **默认路径**：沿用 `settings/describe` 的 `obsidian_dir`；本页只读展示，若要修改引导到设置页。
- **打开方式**：继续使用 `obsidian://open?path=...`，失败时提示手动复制路径。
- **生成/刷新**：默认 `force=false` 增量更新；用户主动点“强制重建”才 `force=true`，且需二次确认。
- **冲突保护**：任何自动生成不得覆盖外部修改；冲突必须进入列表，不做静默覆盖。
- **可访问性**：冲突列表每一行都带文本状态，不只靠颜色。

---

## 8. 异常、边界与安全

### 8.1 通用错误

- RPC 未接入：页面显示「xxx 端点尚未接入 RPC」的空态/提示，与现有知识页一致。
- 长任务：所有提交按钮在 busy 时 disabled，且文字变为“处理中…”。
- 多次点击：构建、生成、转换、回索引均做前端互斥；同一 job 轮询有 cleanup，防止卸载后 setState。
- 后端错误码：统一 `errText(cause)` 展示到就近 Note；不吞错、不假装成功。

### 8.2 各页面边界

| 页面 | 边界 |
|---|---|
| 代码图谱 | 未构建、构建失败、查询无结果、受影响文件无匹配、flows 为空、图谱路径不可读 |
| 知识图谱 | Graphify 未就绪时仍展示审核列表；节点 > 500 降级；缺失目标可视化；不得隐藏审核引用 |
| 文档转换 | 空文件、超大文件、不支持格式、转换失败、预览内容过大、历史重复提交 |
| Obsidian | 未配置路径、路径不存在、生成中断、外部修改冲突、冲突无法自动解决、只读文件系统 |

### 8.3 安全提示

- 文档转换只接受用户主动选择的文件；前端不传任意服务端路径（控制台统一用文件名 + base64）。
- 影响面输入只作为查询参数，不执行命令；显示原样文本，不用 HTML 渲染。
- Obsidian 冲突不自动覆盖；用户主动“保留 Weave”时需二次确认。

---

## 9. 可访问性与响应式

### 9.1 键盘与读屏

- 所有按钮/输入/链接保持原生语义；导航已有 `aria-label`。
- 图谱 SVG 容器加 `role="img"` 与 `aria-label`；若节点可点击，建议 `tabIndex=0` / `role="button"`，并支持 Enter/Space 触发详情。
- Tab 切换使用原生 `button` + `aria-selected`（或 `data-active` + 可见文本），不只靠颜色。
- 进度条使用 `role="progressbar"` + `aria-valuenow`（可确定时）。

### 9.2 响应式

- 沿用 `@media (max-width:900px)`（现有 `.weave-layout` 单列）。
- 移动端：摘要卡保持 2 列（`minmax(150px,1fr)` 可选）；Tabs 允许横向滚动；长结果面板内部滚动。
- 按钮触控高度按现有 `min-height:34px`；主操作可在移动端吸底（若页面操作频繁）。

### 9.3 视觉一致性

- 状态只用颜色+文字双重表达。
- 所有新控件圆角/边框/间距与现有 `.weave-*` 对齐：卡片 12px、面板 16px、按钮 10px、图标 16-18px。

---

## 10. 实施拆分与前端实现成本

### 10.1 建议的编码顺序（frontend-1）

1. **路由与导航**：加 `code` / `convert` / `obsidian` 三个 Route，先放占位 EmptyState。
2. **代码图谱页**：摘要卡 + Tabs + 文本结果 + 影响面列表；依赖 T1/T2。
3. **文档转换页**：文件选择 + 状态轮询 + 预览；依赖 T6。
4. **Obsidian 页**：状态卡 + 动作 + 冲突列表；依赖 T3。
5. **知识库升级**：移除旧文案，接入 `source`/社区显示，保留审核；依赖 T-KG/T4。
6. **e2e 锚点**：按本文 data-testid 补充 harness/live 用例。

### 10.2 复用清单

| 复用点 | 来源 |
|---|---|
| `useResource` / `useAction` / `Note` / `EmptyState` / `Pill` / `ConfirmDialog` | 现有 `src/client/index.ts` |
| `.weave-grid` `.weave-card` | 总览/团队 |
| `KnowledgeGraphView` 环形布局 | 现知识图谱，升级时直接改数据映射 |
| 文件选择/预览 | 现有 `KnowledgeImportPanel` 可提炼或复制 |
| `obsidian://open`、复制路径 | 现 Obsidian 面板 |
| `.weave-dot` 状态色 | 全局 |

### 10.3 不建议做的事

- 不引入 React Flow / D3 / markdown 渲染库（单文件 bundle 约束，成本高）。
- 不把全部 code graph 节点画成 SVG（1177+ 节点会卡）。
- 不在代码图谱页复制任务治理/会话功能。
- 不把 Obsidian 双向同步与知识审核混为一页（可入口互通，不做耦合）。

---

## 11. 与验收/E2E 对齐

| 验收项 | 对应 UI 锚点/动作 |
|---|---|
| 控制台代码图谱页可用，展示节点/社区/影响面 | `page-code`、`code-summary-*`、`code-tab-affected` |
| 知识图谱替换为 Graphify 结果，保留审核流程 | `page-knowledge`、`knowledge-graph-source-badge`、`knowledge-approve/reject-*` |
| Obsidian 生成、打开、回索引、外部修改不覆盖 | `page-obsidian`、`obsidian-generate/open/reindex`、`obsidian-conflict-*` |
| AnyDoc 独立转换控制台可用 | `page-convert`、`convert-submit/status/preview` |
| 不依赖团队可独立使用 | 页面不显示团队绑定依赖；路由可独立打开 |

---

## 12. 开放问题（需与后端/队长确认）

1. `code/graph` 是否提供节点/边列表或只提供摘要？若只提供摘要，本稿的“社区卡片/节点搜索”需要改由 `code/explain` 或新增 `code/nodes` 支撑。
2. `document/convert` 最终按“base64 上传”还是“服务端路径”实现？本稿按控制台用前者、CLI 用后者设计。
3. `obsidian/status`、`obsidian/generate` 的 job 轮询是否需要标准 jobId 队列？建议与 `document/status` 统一。
4. 知识图谱 Graphify 是否保留双链兼容开关？本稿按自动兼容设计，具体降级策略由后端决定。
5. 首次生成/强制重建 Obsidian 是否都走二次确认？本稿默认首次生成确认、强制重建必确认。
