# 织 · Weave 功能设计文档（FDD）

| 元信息 | 内容 |
| --- | --- |
| 文档版本 | v0.2.0 |
| 日期 | 2026-08-24 |
| 状态 | 正式版 · Phase 0 开发基线 |
| 上游依据 | `doc/design/架构设计文档.md` v0.2.0（含附录 C 知识导入与角色学习决策） |
| 覆盖范围 | P0 / P1 功能、角色场景、验收标准、非功能需求、边界与范围 |
| 第 2 轮修订 | 2026-08-25：按《doc/reports/review-report-round1.md》§2 实证事实 E2-E5 对齐真实 DSH 0.1.1-rc.2 `ctx.subagents` API 契约（F-05、§4.9.3 能力模型、§5 安全/非交互模式、§7.1 第 5 项） |

---

## 1 目标

### 1.1 文档目标

本功能设计文档（FDD）面向研发、测试、产品与团队管理员，回答“Weave v0.2.0 要交付哪些能力、为谁服务、如何验收”三个问题。

文档严格对齐架构文档 v0.2.0 的以下基线：

- 执行器调用基于 DSH 原生 `ctx.subagents` API，删除自研进程管理；
- 保温期修订依靠上下文注入（ephemeral 线程无跨任务记忆）；
- 新增 `ExecutorRegistry`，执行器收敛为 DSH 子代理 / Codex / Claude Code / 其它 ACP 四类；
- 知识导入以 Web 界面为主，AnyDoc 统一转换为 GitHub-Flavored Markdown；
- AnyDoc、Graphify 等是“知识导入源/转换器”，不是执行器；
- 附录 C 明确：P0 不做链接与浏览器采集。

### 1.2 产品目标

Weave 是构建在 DSH 之上的多 Agent 团队协作与知识成长框架。产品目标如下：

1. **团队协作**：以任务 DAG 为核心，把复杂工作拆解、分配、执行、反馈、修订串成闭环。
2. **角色学习**：让角色通过导入项目文档、技能文档、历史任务沉淀，持续获得可注入的知识。
3. **知识导入**：让文档（DOC/DOCX/PDF/PPT/Excel/EPUB/CSV/RTF/ODT）通过 AnyDoc 平滑进入 Markdown 知识库。
4. **知识库/图谱**：以 Markdown + frontmatter 为主存储，以 Obsidian Vault 提供人工可见入口，以 Graphify + Cytoscape.js 提供 P1 图谱视图。
5. **无侵入**：执行器无需感知 Weave；Weave 只负责组装上下文、跟踪状态、沉淀知识。

### 1.3 非目标

- 不自行管理子代理进程（交给 DSH `ctx.subagents`）；
- 不在核心调度中加入 LLM 推理（P0 核心规则驱动）；
- 不在 P0 提供网页链接导入、浏览器插件/自动化采集；
- 不在 P0 做 Obsidian 双向同步；
- 不把 AnyDoc/Graphify 当作执行器。

---

## 2 角色与场景

### 2.1 角色定义

Weave 中“角色”包含两类：

- **人类使用角色**：团队管理员、项目负责人、知识管理员、业务用户。
- **Agent 执行角色**：在 `team.yaml` 中配置，如 `designer`、`coder`、`reviewer`，每个角色绑定一个执行器。

#### 2.1.1 人类角色

| 角色 | 类型 | 主要职责 | 主要使用功能 |
| --- | --- | --- | --- |
| 团队管理员 | 管理员 | 配置团队/角色/执行器、查看全局运行状态、处理熔断与限流 | 团队配置、执行器管理、任务中心、审计日志 |
| 项目负责人/任务发起者 | 业务/管理 | 提交任务、查看 DAG、接收产出、给出反馈、确认关闭 | 任务提交、任务状态、保温期反馈、DAG 面板 |
| 知识管理员/审核员 | 知识管理 | 导入文档、预览编辑 candidate、审核转正/拒绝、处理 supersede | 知识导入、AnyDoc 转换、知识审核、知识库 |
| 业务用户/消费者 | 业务 | 查看知识库、Obsidian、图谱，作为任务反馈来源 | 知识检索、Obsidian 打开、Graphify 查看 |

#### 2.1.2 Agent 执行角色

角色配置示例（来自架构文档 `team.yaml`）：

```yaml
roles:
  - id: designer
    name: 方案设计师
    bias: design
    executor: codex
    stages: [prepare, design]        # HI-4：该角色可执行的 DAG 阶段
    max_concurrent_tasks: 1
    personality: |
      你是方案设计师，注重简洁性和可扩展性。

  - id: coder
    name: 核心开发
    bias: dev
    executor: zcode
    stages: [implement, test, integrate, execute, deploy]
    max_concurrent_tasks: 2
    personality: |
      你追求代码质量和性能。
```

每个角色必须具备：

- 唯一 `id`；
- 已注册的执行器绑定（`executor` 必须在 `ExecutorRegistry` 中存在）；
- `max_concurrent_tasks > 0`；
- 非空 `stages`：该角色可执行的 DAG 阶段名集合（阶段→角色绑定依据，见 4.4.5）；
- 可选的 `personality`、`bias` 等元信息。

### 2.2 典型场景

#### 场景 S1：知识导入与 candidate 形成

团队管理员通过 Web 界面“导入知识”上传《XX 接入指南.docx》：

1. 选择文件并拖拽上传；
2. AnyDoc 将 DOCX 转换为 GitHub-Flavored Markdown；
3. 系统生成 `status: candidate` 知识卡片；
4. 用户预览、编辑标题/正文/标签后确认；
5. 知识进入审核流程；
6. 审核通过后成为 `active`，供角色任务注入。

#### 场景 S2：角色学习

1. 在 `team.yaml` 定义角色 `designer`；
2. 通过界面导入项目文档/技能文档，选择归属（角色/项目/版本/知识层级）；
3. AnyDoc 转为 Markdown；
4. 生成 candidate 知识卡片；
5. 审核转正 `candidate → active`；
6. 角色执行任务时，`KnowledgeEngine` 自动检索并注入相关知识；
7. 任务失败/高效产出沉淀 Pitfall/Pattern，同样走 candidate 审核。

#### 场景 S3：任务 DAG 协作

用户提交“实现用户登录模块”：

1. `Orchestrator` 通过 `task_decomposition.matchers` 匹配难度；
2. 根据 `dag_templates` 生成 DAG（如 `design → implement → review → test`）；
3. 各任务按依赖顺序分配到角色/执行器；
4. 任一任务失败，下游自动 `SKIPPED`；
5. 会话右侧面板实时显示 DAG，支持快速取消；
6. Dashboard 提供完整视图。

#### 场景 S4：保温期反馈与修订

任务完成后进入 `AWAITING_FEEDBACK`（默认 1800s）：

1. 用户反馈“改成手机号验证码”；
2. `FeedbackRouter` 识别为 `revise`；
3. `SessionTracker` 取出上一版输出与反馈历史；
4. `DelegationService` 构建修订 prompt 并注入；
5. 子代理产出 v2，任务回到 `COMPLETED`，保温期重置；
6. 用户确认后 `CLOSED`；或超时自动 `CLOSED`；24h 内可 reopen。

#### 场景 S5：执行器管理

- 管理员打开“执行器”页面；
- 系统通过 `ctx.subagents.list()` 自动发现 DSH 子代理、Codex、Claude Code、ACP 工具；
- 页面展示运行中进程数、每小时频率、来源；
- CLI `/weave executor list` 可查看同一信息；
- 非 P0 可注册自定义 CLI 执行器，作为 ACP 不可用时的后备。

#### 场景 S6：知识库与图谱浏览

- 用户进入“知识库”页面，按项目/角色/实例/全局筛选；
- 点击“打开 Obsidian”进入 `~/.dsh/obsidian` Vault；
- P1 中 Graphify 生成 `graph.json` / `graph.html` / Obsidian Vault；
- Cytoscape.js 展示图谱，支持 `query / path / explain`。

#### 场景 S7：多团队选择

- 优先级链：显式指定 > 会话绑定 > 默认团队 > 仅一个团队 > 提示选择；
- 管理员可通过界面或 CLI 切换团队；
- 项目与版本隔离保证单活动版本约束。

### 2.3 角色-功能矩阵

| 功能 | 团队管理员 | 项目负责人 | 知识管理员 | 业务用户 |
| --- | --- | --- | --- | --- |
| 团队/角色配置 | ✔ P0 | 查看 | — | — |
| 执行器管理 | ✔ P0 | — | — | — |
| 任务提交/DAG | 查看 | ✔ P0 | — | 只读 |
| 保温期反馈 | — | ✔ P0 | — | ✔ P0 |
| 知识导入 | ✔ P0 | ✔ P0 | ✔ P0 | 只读 |
| 知识审核 | — | 可参与 | ✔ P0（HI-5：审核队列 + approve/reject） | — |
| 知识检索 | ✔ P0 | ✔ P0 | ✔ P0 | ✔ P0 |
| Obsidian 入口 | ✔ P0 | ✔ P0 | ✔ P0 | ✔ P0 |
| Graphify 图谱 | ✔ P1 | ✔ P1 | ✔ P1 | ✔ P1 |

---

## 3 功能清单

### 3.1 优先级定义

| 优先级 | 含义 | 排期 |
| --- | --- | --- |
| P0 | Phase 0 必须交付，进入验收 | v0.2.0 Phase 0（约 2 周） |
| P1 | Phase 1-3 计划交付 | 知识体系、成长系统、保鲜、UI 完善 |

说明：架构文档附录 C 中“Web 导入知识”明确为 P0 入口；知识审核队列（approve/reject，candidate→active/→deprecated）为 P0（HI-5）；完整知识体系检索权重、人工 supersede、保鲜、图谱、双向反思等归入 P1。

### 3.2 P0 功能清单

| 编号 | 功能 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| F-01 | 团队与角色配置加载/校验 | P0 | `team.yaml` 加载成功；角色 id 唯一；`executor` 必须在注册表中；`schema_version = "1"`；`max_concurrent_tasks > 0`；任一项失败会明确报错并阻止该团队启用。 |
| F-02 | 执行器发现与分类注册 | P0 | 执行器 Bundle（P0-EXEC-021）安装并启用后，`ExecutorRegistry.load()` 基于 `ctx.subagents.list()` 自动发现全部 provider；正确分类为 `dsh_subagent / codex / claude_code / acp`；`get/list/kindOf` 查询正确。若 Bundle 与 DSH `0.1.1-rc.2` 不兼容（任务规划方案B），codex/claude_code/acp 分类以 mock + 安装后验证为准。 |
| F-03 | 任务提交与 DAG 构建 | P0 | 提交任务后按 `matchers` 匹配难度（未命中用 `default_difficulty` 兜底），按 `dag_templates` 生成 DAG（每任务含 `stage` 与角色绑定，规则见 4.4.5）；任务 ID 连续且全局唯一；DAG 可持久化（`dags`/`edges`/`tasks.dag_id`，HI-3）、可查询（`getDag` 三表联合读取）。 |
| F-04 | 任务状态机与依赖传播 | P0 | 14 态 `WAITING/BLOCKED/RUNNING/COMPLETED/AWAITING_FEEDBACK/REVISION_RUNNING/CLOSED/FAILED/SKIPPED/BANNED/COOLDOWN/LOOP_TERMINATED/INTERRUPTED/CANCELLED` 状态转移正确（权威矩阵见 TDD §2.1.5，32 条）；任一失败终态使全部下游进入 `SKIPPED`；上游 retry/skip 后非 override 下游可重激活，迭代保护 100 次；修订失败走 `REVISION_RUNNING → FAILED` 并保留修订上下文（ME-5）。 |
| F-05 | 统一委托执行 | P0 | 所有执行器统一通过 `ctx.subagents.start(role.executor, { prompt: ContentBlock[], parent, signal })` 调用；Weave 不 spawn/kill 进程；错误映射按 DSH `SubagentResult.stopReason`（`completed`→COMPLETED；`aborted`→CANCELLED；`error`/`max-tokens`/`refusal`→FAILED 计熔断；`timeout` 为 Weave 应用层判定→FAILED 计熔断；`unavailable`→委托前拦截不计熔断）；`permission_denied` 仅为可选启发式识别（见 §4.9.3），不作 P0 强制。 |
| F-06 | 保温期与反馈路由 | P0 | 任务进入 `AWAITING_FEEDBACK` 后默认 1800s 超时；接受/修订/取消意图识别正确；确认后 `CLOSED`；24h 内可 reopen。 |
| F-07 | 修订上下文注入 | P0 | 修订 prompt 必须包含“上一版输出 + 用户反馈历史 + 修订次数”；`SessionTracker` 正确记录和清理 `RevisionRecord`；两次调用无跨任务状态残留。 |
| F-08 | 安全熔断与限流 | P0 | 断路器 ACTIVE → BANNED → COOLDOWN → ACTIVE；连续失败≥3 触发；最窄 scope 优先；循环检测覆盖步数/工具重复/输出零增长/时间限制；per-executor 并发和小时频率超限时排队等待，不触发熔断。 |
| F-09 | 知识导入 Web 入口 | P0 | Web 页面提供“导入知识”入口，支持文件上传与拖拽；支持的扩展名包含 DOC/DOCX/PDF/PPT/Excel/EPUB/CSV/RTF/ODT；上传后进入转换流程。 |
| F-10 | AnyDoc 统一转换 | P0 | 任一支持格式通过 AnyDoc 统一转换为 GitHub-Flavored Markdown；转换失败有明确错误提示；转换结果可预览；转换器不注册为执行器。 |
| F-11 | candidate 知识生成与预览/编辑/确认 | P0 | 转换完成后自动生成 `status: candidate` 知识卡片；用户可预览、编辑标题/正文/标签/归属并确认；确认后进入待审核队列，不能直接成为 active。 |
| F-12 | 知识检索与任务注入 | P0 | 委托执行前 `KnowledgeEngine.searchForInjection()` 返回可注入知识；注入限制：`max_entries: 5`、`max_chars_per_entry: 500`、`max_total_chars: 2500`、`priority: freshness_first`；prompt 中正确展示相关知识点。 |
| F-13 | MCP 任务管理工具 | P0 | 提供 `weave_submit_task / weave_get_status / weave_revise_task / weave_accept_task / weave_team_list / weave_team_switch`；工具返回结构化 JSON；错误码可诊断。 |
| F-14 | CLI 命令 | P0 | `/weave team list/switch`、`/weave task submit/status/revise/accept/retry/skip/cancel/reopen`、`/weave dag <dag_id>`、`/weave executor list`、`/weave ban list` 均可执行并正确操作。 |
| F-15 | DAG 面板与执行器页面 | P0 | DSH 会话右侧面板自动加载当前任务 DAG，支持实时查看与快速取消；“执行器”页面展示所有已发现执行器、运行中进程数、每小时频率、来源；DSH 设置页面不出现 Weave 条目。数据源（ME-7）：provider 列表 = `ctx.subagents.list()`；运行中进程数/每小时频率 = Weave 自计数（`ProcessLimiter.status()`），DSH API 无对应字段；来源 = provider 名。 |
| F-16 | Obsidian 打开入口 | P0 | 知识主存储为 Markdown + frontmatter；提供“打开 Obsidian”入口，打开 `~/.dsh/obsidian/`；P0 不要求双向同步。 |
| F-17 | 持久化与单写者队列 | P0 | SQLite WAL 模式；核心表（tasks/feedback_routes/knowledge_meta/task_sequences/bans/failure_counters）建表正确；所有写操作经单写者队列串行化；崩溃恢复后状态一致。 |
| F-18 | 多团队与项目版本隔离 | P0 | 团队选择优先级链“显式 > 会话绑定 > 默认 > 仅一个 > 提示”正确；任务与知识均带 `project_id + version`，单活动版本约束生效，不同版本互不混用。 |

### 3.3 P1 功能清单

| 编号 | 功能 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| F-21 | 角色学习完整闭环 | P1 | 角色知识可随文档导入和任务沉淀自动增长；`KnowledgeEngine` 按角色/项目/版本检索并注入；失败沉淀 Pitfall、高效模式沉淀 Pattern，均走 candidate 审核。 |
| F-22 | 四层知识体系与检索权重 | P1 | 项目/角色/实例/全局四层目录正确；检索权重表与架构一致（项目 1.0、跨版本共享 0.9、实例 0.85、同项目角色 0.8、全局 0.6、跨项目角色 0.4、其他版本 0.3 默认不参与）；结果按 `freshness_score` 排序。 |
| F-23 | 知识审核与人工 supersede | P0+P1 | P0（F-23a）：Web/CLI/MCP 提供 `weave_knowledge_review/approve/reject` 审核队列；`candidate → active`（approve）、`candidate → deprecated`（reject）；写入 `knowledge_meta` 与审计事件；三目录 `_agent/_human/_views` 隔离正确。P1（F-23b）：`candidate/active → deprecated` 生命周期维护、人工 `supersede`（active → superseded + 新 id 关联）、`weave_knowledge_search` 作为审核入口。 |
| F-24 | 双向反思成长 | P1 | 负向反思在任务失败/崩溃/超时后 200% 采样产出 Pitfall；正向反思在耗时 < 同桶 P50×0.7 时产出 Pattern；分桶维度为任务类型/执行器/上下文长度，样本不足自动降维，minSamples=10。 |
| F-25 | 知识保鲜 | P1 | 时间衰减、运行时校验、后台巡检、冲突替代四层机制生效；`freshness_score` 可衰减；被替代知识标记 deprecated 或 superseded，并记录审计事件。 |
| F-26 | Graphify 知识图谱 | P1 | Graphify 以项目目录/知识目录为输入，输出 `graph.json`、`graph.html`、Obsidian Vault；Weave 用 Cytoscape.js 展示；支持 `query / path / explain`；Graphify 不作为执行器。 |
| F-27 | Obsidian 双链增强 | P1 | 支持 `[[双链]]` 作为轻量知识关联；知识条目可被 Graphify 提取到 Obsidian Vault；不做实时双向同步。 |
| F-28 | 自定义 CLI 执行器（可选后备） | P1 | 无 ACP 工具时可通过 `~/.dsh/executors.yaml` 注册自定义 CLI；支持 command、args_template、timeout、cancel_signal、process_limits；配置校验失败时明确报错。 |
| F-29 | 链接与浏览器采集（暂缓） | 暂缓 | 明确不列入 Phase 0；P0/P1 不验收；后续仅作候选方案评估。 |

---

## 4 功能详述

### 4.1 知识导入

#### 4.1.1 定位

知识导入是角色学习和知识库建设的 P0 入口。按附录 C.1，以界面操作为主，CLI/MCP 仅作自动化补充。

#### 4.1.2 支持类型

- DOC(`.doc`) / DOCX(`.docx`) / PDF(`.pdf`) / PPT(`.ppt`, `.pptx`) / Excel(`.xls`, `.xlsx`) / EPUB(`.epub`) / CSV(`.csv`) / RTF(`.rtf`) / ODT(`.odt`)；
- 后续如扩展类型，沿用 AnyDoc 统一转换，不改业务入口。

#### 4.1.3 流程

```
用户上传/拖拽文件
  → 识别格式
  → AnyDoc 转换为 GitHub-Flavored Markdown
  → 提取标题 / 正文 / 标签 / 归属
  → 生成 candidate 知识卡片（status=candidate, confidence=0.1）
  → 用户预览、编辑、确认
  → 进入审核队列
  → （P1）审核通过后 candidate → active
```

#### 4.1.4 归属选择

- **项目**：`project_id + version`；
- **角色**：`role_id`；
- **实例**：`instance_id`；
- **全局**：`shared`。

每个 candidate 必须带 `schema_version: "1"`、`type`、`status`、`confidence`、`created`、`freshness_score`、`visibility`、`tags`。

#### 4.1.5 验收要点

- 拖拽/选择文件均可启动导入；
- 不支持的类型给出明确提示；
- 转换结果可在线预览；
- 未确认前不写入 active 知识库。

### 4.2 AnyDoc 转换

#### 4.2.1 选型

- **唯一选型：`@firecrawl/anydoc`**（`dsh-plugin-anydoc` 不作为 Phase 0 选项；若后续出现独立 DSH 插件封装包，仅作为扩展另行评估）；
- 选型可安装性纳入 P0-ENV-001 / P0-EXEC-021 验证（基线环境未安装，见审核报告 E8）；
- 统一输出 GitHub-Flavored Markdown（GFM）；
- 与 DSH/Weave 的 Markdown + frontmatter 主存储兼容。

#### 4.2.2 职责边界

AnyDoc 是知识导入源/转换器，**不是执行器**。它不参与任务委托，不通过 `ctx.subagents.start` 调用，不受执行器限流管理。

#### 4.2.3 转换约定

| 内容 | 约定 |
| --- | --- |
| 文件类型 | 按 DOC/DOCX/PDF/PPT/Excel/EPUB/CSV/RTF/ODT 识别 |
| 输出格式 | GitHub-Flavored Markdown |
| 图片/资源 | 按 AnyDoc 能力转为引用路径或附件，P0 不保证复杂版式还原 |
| 失败处理 | 记录错误并在 Web 界面展示可读原因 |
| 安全 | 导入时不执行文件内宏/脚本，仅做文档解析 |

#### 4.2.4 验收要点

- 每个支持格式至少一条最小可转换样本通过；
- 转换结果可被知识预览页面渲染；
- 转换失败不会污染知识目录。

### 4.3 角色学习

#### 4.3.1 定义

角色学习是“角色配置 + 知识导入 + 任务执行 + 知识回流”的闭环。按附录 C.2 流程执行：

1. 在 `team.yaml` 定义角色；
2. 通过界面导入项目文档/技能文档，选择归属（角色/项目/版本/知识层级）；
3. AnyDoc 将文档转为 Markdown；
4. 生成 candidate 知识卡片；
5. 审核转正 candidate → active；
6. 角色执行任务时，KnowledgeEngine 自动检索并注入相关知识；
7. 任务沉淀：失败产生 Pitfall，高效模式产生 Pattern，同样走 candidate 审核。

#### 4.3.2 P0/P1 拆分

| 阶段 | 内容 |
| --- | --- |
| P0 | 角色定义、知识导入、AnyDoc 转换、candidate 生成、最小知识检索注入 |
| P1 | 自动反思沉淀、置信度增长、角色知识自动转正、完整四层权重、保鲜 |

#### 4.3.3 角色学习对执行的影响

- 每次委托前，`DelegationService` 调用 `KnowledgeEngine.searchForInjection(...)`；
- 检索结果按 `freshness_first` 截断到注入上限；
- 角色人格和知识注入共同构成 prompt 的“角色记忆”。

#### 4.3.4 验收要点

- 新角色导入文档后，在执行任务时 prompt 中可见相关知识；
- 同一角色在不同项目/版本下检索结果隔离正确；
- 任务失败/高效产出的沉淀条目能进入 candidate 队列。

### 4.4 任务 DAG

#### 4.4.1 规则驱动分解

`Orchestrator` 使用 `task_decomposition.matchers` 匹配难度：

| 难度 | 示例模式 | 默认 DAG |
| --- | --- | --- |
| easy | 修复、调整 | `execute` |
| medium | 新增、实现、集成 | `design → implement → test` |
| hard | 复杂需求 | `design → implement → review → test → integrate` |
| critical | 重构/核心/关键/安全 | `prepare → design → implement → review → test → deploy` |

- matcher 多命中取最高难度（critical > hard > medium > easy）；未命中 → `default_difficulty`（缺省 `hard`）——HI-4；
- 阶段→角色绑定规则见 4.4.5。

#### 4.4.2 状态机

支持 14 态与 32 条转移，核心表示：

```
| # | 当前 → 目标 | 触发 | 说明 |
| --- | --- | --- | --- |
| 1 | WAITING → BLOCKED | 依赖检查：上游未全部到成功终态 | 上游完成/失败时由传播规则（2.2.4）重估 |
| 2 | BLOCKED → WAITING | 依赖全部满足（或上游被 override） | 进入就绪队列 |
| 3 | WAITING → RUNNING | runReadyTasks 派发（角色软限制 + 执行器槽位） | 角色已绑定（见 2.2.7） |
| 4 | RUNNING → COMPLETED | stopReason=completed | 写 result；随后自动进入 AWAITING_FEEDBACK（#10） |
| 5 | RUNNING → FAILED | 按错误映射（error/max-tokens/refusal/基础设施 reject/timeout/可选 permission_denied） | 写 error_type；计熔断 |
| 6 | RUNNING → BANNED | 断路器触发（连续失败 ≥ 3） | 计熔断；后续 #20/#21 |
| 7 | RUNNING → LOOP_TERMINATED | 循环检测命中 | 计熔断（循环防护） |
| 8 | RUNNING → INTERRUPTED | 外部中断（非用户取消） | 可恢复（#26）或取消 |
| 9 | RUNNING → CANCELLED | 用户取消 | 不计熔断；stopReason=aborted |
| 10 | COMPLETED → AWAITING_FEEDBACK | 自动进入保温期 | feedback_expires_at = now + 1800s |
| 11 | AWAITING_FEEDBACK → REVISION_RUNNING | 用户 revise | revision_count+1；recordRevision；保温期重置 |
| 12 | AWAITING_FEEDBACK → CLOSED | accept 或保温期超时 | clearRevision；写 closed_at |
| 13 | AWAITING_FEEDBACK → CANCELLED | 用户 cancel | 终态，参与失败传播 |
| 14 | REVISION_RUNNING → COMPLETED | 修订委托完成 | 写 result；保温期重置 |
| 15 | REVISION_RUNNING → FAILED | 修订失败/超时（ME-5） | previous_result 保留；revision_count 不回退；可 #18 retry |
| 16 | REVISION_RUNNING → CANCELLED | 修订取消（ME-5） | 不计熔断；上下文保留 |
| 17 | CLOSED → AWAITING_FEEDBACK | reopen（24h 窗口内） | reopen_count+1；保温期重置 |
| 18 | FAILED → WAITING | retry | 失败计数保留（断路器侧） |
| 19 | FAILED → SKIPPED | skip | skip_override=1 |
| 20 | BANNED → COOLDOWN | 冷却开始（expiry/手动解除） | 记录 cooldown_seconds |
| 21 | BANNED → SKIPPED | skip（熔断下） | skip_override=1 |
| 22 | COOLDOWN → WAITING | 冷却结束 | 可再次派发 |
| 23 | COOLDOWN → SKIPPED | 冷却期间 skip | skip_override=1 |
| 24 | LOOP_TERMINATED → WAITING | retry | — |
| 25 | LOOP_TERMINATED → SKIPPED | skip | — |
| 26 | INTERRUPTED → WAITING | retry | — |
| 27 | INTERRUPTED → SKIPPED | skip | — |
| 28 | INTERRUPTED → CANCELLED | cancel | 终态 |
| 29 | CANCELLED → WAITING | retry | 终态恢复（用户显式） |
| 30 | CANCELLED → SKIPPED | skip | — |
| 31 | WAITING → CANCELLED | cancel（等待中） | — |
| 32 | BLOCKED → CANCELLED | cancel（阻塞中） | — |

> 权威矩阵（含前置条件与副作用分列）见 TDD §2.1.5。`COOLDOWN` 为第 14 态：唯一路径 BANNED → COOLDOWN → WAITING（或人工 COOLDOWN → SKIPPED）。失败终态 FAILED/BANNED/LOOP_TERMINATED/CANCELLED 触发下游 SKIPPED 传播；SKIPPED 为吸收态（重激活由 reactivateSkipped 恢复，迭代保护 100 次）；修订失败见 #15/#16（ME-5）。

```

失败终态：`FAILED / BANNED / LOOP_TERMINATED / CANCELLED`，触发下游 `SKIPPED` 传播；修订失败走 `REVISION_RUNNING → FAILED`（#15），修订上下文保留（ME-5）。

#### 4.4.3 UI

- 会话右侧面板：轻量实时 DAG，支持查看 + 快速取消；
- 完整视图：Dashboard 任务中心，支持图表与历史查询；
- 全局任务 ID 序列：单事务 UPSERT `task_sequences` 获取连续序号，批量 INSERT tasks。

#### 4.4.4 验收要点

- 提交文本能正确匹配难度并生成 DAG；
- 依赖失败传播后，所有下游不可执行任务进入 SKIPPED；
- SKIPPED 重激活受 override 控制和 100 次迭代保护；
- 右侧面板和 Dashboard 展示一致。

#### 4.4.5 阶段 → 角色绑定与难度兜底（HI-4）

- 角色在 `team.yaml` 中声明 `stages`（可执行阶段名集合）；
- 绑定：模板中的每个阶段按 `roles` 声明顺序取第一个声明该阶段的角色；结果写入 `tasks.assigned_agent`（角色 id）与 `tasks.stage`（阶段名）；执行器 id 经 `role.executor` 解析；
- 兜底：无角色声明时按“阶段名 = 角色 id”隐式匹配；仍无 → `configuration_error`（不静默跳过任务）；
- matcher 未命中 → `default_difficulty`（缺省 `hard`）；多命中取最高难度；
- `runReadyTasks` 据此把每个任务绑定到角色与执行器；角色级 `max_concurrent_tasks` 为调度软限制，`executor_limits` 为执行器级硬限制（ME-3/ME-6）。

### 4.5 知识注入

#### 4.5.1 注入时机

- 首次执行：prompt = 角色人格 + 任务描述 + 知识注入；
- 修订执行：prompt = 角色人格 + 任务描述 + 知识注入 + 上一版输出 + 用户反馈历史。

#### 4.5.2 注入限制

来自 `team.yaml` 的 `knowledge_injection`：

```yaml
knowledge_injection:
  max_entries: 5
  max_chars_per_entry: 500
  max_total_chars: 2500
  priority: freshness_first
```

#### 4.5.3 检索权重（P1 完整版）

| 来源 | 权重 |
| --- | --- |
| 当前版本项目知识 | 1.0 × freshness |
| 跨版本共享项目知识 | 0.9 × freshness |
| 实例知识 | 0.85 × freshness |
| 角色知识（同项目） | 0.8 × freshness |
| 全局知识 | 0.6 × freshness |
| 角色知识（跨项目） | 0.4 × freshness |
| 其他版本项目知识 | 0.3 × freshness（默认不参与） |

#### 4.5.4 Prompt 格式

```text
## 相关知识（来自知识库）
{relevant_knowledge}
```

P0 阶段执行器**不**调用 `/weave knowledge search`（该 CLI 属 P1，见 TDD 1.2.7）；执行器如需补充知识，仅基于已注入 prompt 的相关知识片段。

#### 4.5.5 验收要点

- 注入条数与字符数不超过配置上限；
- 修订时注入内容包含上一版和反馈；
- 检索结果按 freshness 优先级选择。

### 4.6 知识审核

#### 4.6.1 生命周期

```
candidate → active → deprecated | superseded
```

- P0（HI-5）：转换后生成 candidate，用户预览/编辑/确认后进入审核队列；提供 approve（candidate → active）/ reject（candidate → deprecated）；
- P1：人工 `supersede`（active → superseded）、`active → deprecated` 生命周期维护、置信度模型与知识保鲜（AC-KNOW-004）。

#### 4.6.2 三目录隔离

```
knowledge/
├── _agent/    # Agent 写入区
├── _human/    # 人工编辑区
└── _views/    # 动态视图
```

- `_agent` 由任务回流或导入自动生成；
- `_human` 供人工编辑与 supersede；
- `_views` 是动态视图，不直接作为知识源。

#### 4.6.3 审核操作

| 操作 | 效果 | 审计事件 |
| --- | --- | --- |
| approve | candidate → active | `knowledge.status_changed` |
| reject | candidate → deprecated | `knowledge.status_changed` |
| supersede | active → superseded, 新 id 关联 | `knowledge.superseded` |
| 编辑 | 修改正文/metadata | 记录变更 |

#### 4.6.4 验收要点

- candidate 不能跳过审核直接 active（除非配置显式人工操作）；
- 审核通过后 KnowledgeEngine 可检索到；
- 审核操作均写入审计日志。

### 4.7 Graphify

#### 4.7.1 定位（P1）

按照附录 C.4：

- 输入：项目目录 / 知识目录；
- 输出：`graph.json`、`graph.html`、Obsidian Vault；
- Weave 用 Cytoscape.js 展示图谱；
- 支持 `query / path / explain`；
- 与 AnyDoc 不冲突，属于 P1。

#### 4.7.2 功能清单

| 功能 | 说明 |
| --- | --- |
| 图谱生成 | 扫描 Markdown 知识、frontmatter、`[[双链]]` 关系 |
| 图谱展示 | Cytoscape.js 渲染节点/边 |
| 查询 | 按关键词/标签/类型查询节点 |
| 路径 | 展示两节点间路径 |
| 解释 | 解释某条边/节点的来源依据 |

#### 4.7.3 边界

- Graphify 不是执行器；
- P0 不构建 Graphify；
- P0 不做浏览器采集与链接导入。

### 4.8 Obsidian

#### 4.8.1 存储兼容

- 知识主存储保持 Markdown + frontmatter，天然兼容 Obsidian；
- `~/.dsh/obsidian/` 作为用户可见 Vault；
- P0 提供“打开 Obsidian”入口；
- P0 不做双向同步。

#### 4.8.2 P1 增强

- 支持 `[[双链]]` 作为轻量知识关联；
- Graphify 可将生成结果输出到 Obsidian Vault；
- 后续如需同步，另行评估。

#### 4.8.3 验收要点

- 知识库文件可被 Obsidian 直接打开；
- “打开 Obsidian”入口路径正确；
- 手动编辑 Obsidian 中的文件不会在 P0 被 Weave 自动覆盖（无双向同步）。

### 4.9 执行器管理

#### 4.9.1 ExecutorRegistry 职责

- 通过 `ctx.subagents.list()` 发现 DSH 已注册的全部 subagent provider；
- 自动分类为 `dsh_subagent / codex / claude_code / acp`；
- 统一提供 `get / list / kindOf` 接口；
- 向 TeamManager 提供执行器可用性校验。

#### 4.9.2 四类执行器

| 类别 | 注册方式 | 调用方式 | 进程管理 | 会话保持 |
| --- | --- | --- | --- | --- |
| DSH 子代理 | DSH 内置 spawn/fork 或自定义 provider | `ctx.subagents.start('spawn'/'fork'/'...')` | DSH 内部 | ephemeral 线程 |
| Codex | `@deepseek-ai/dsh-subagent-codex` | `ctx.subagents.start('codex', request)` | DSH 内部 | 一次性/由 provider 决定 |
| Claude Code | `@deepseek-ai/dsh-subagent-claude-code` | `ctx.subagents.start('claude-code', request)` | DSH 内部 | 一次性/由 provider 决定 |
| 其它 ACP 工具 | `@deepseek-ai/dsh-subagent-acp` | `ctx.subagents.start('zcode'/'...', request)` | DSH 内部 | ACP 进程内驱动 |

#### 4.9.3 执行器能力模型

```typescript
import type { SubagentCapabilities } from '@deepseek-ai/dsh-subagent'

interface ExecutorInfo {
  id: string
  name: string
  kind: ExecutorKind
  /** 真实 DSH SubagentCapabilities：outputSchema / depthLimit / toolFilter / persona（start-time 特性声明） */
  capabilities: SubagentCapabilities
}
```

- 数据源：`ctx.subagents.getProvider(name).capabilities`（provider 注册时声明），非 Weave 推断；
- 原 `supports_feedback_loop / non_interactive / ephemeral_session` 在 DSH API 中无数据源，已删除；
- 该字段 P0 无消费方，仅作执行器页面展示/预留；
- `permission_denied`：DSH 无此 stopReason 枚举；非交互拒绝以子代理输出/诊断文本体现，Weave 提供**可选**启发式识别（匹配"需要批准 / 授权 / approval required / permission denied"等模式），命中则任务 FAILED 并记录 `error_type='permission_denied'`（审计辅助标记），未命中按 stopReason 映射；不作为 P0 验收强制项（见 §7.1 第 5 项）。

#### 4.9.4 页面与 CLI

- Web 页面展示运行中进程数、每小时频率、来源；
- CLI `/weave executor list`；
- 支持 ACP 工具注册；
- 非 P0 支持自定义 CLI 执行器（后备）。

#### 4.9.5 验收要点

- 所有四类执行器都能通过 `ctx.subagents.start` 调用并返回；
- 未注册执行器导致团队配置校验失败；
- 执行器页面不复用 DSH 设置页入口。
- ACP 生产启用依赖部署配置：`dsh-subagent-acp` 需在部署环境配置真实 ACP `command` 后方可启用（模板见 `P0-EXEC-021-conclusion.md` §4.3；P0 验收无需 ACP 端到端，P0-TEST-019 真实环境冒烟以 spawn/fork 与已启用 provider 为准）。

---

## 5 非功能需求

| 类别 | 需求 | 度量/约束 |
| --- | --- | --- |
| 性能 | 任务提交到 DAG 生成应可交互 | 普通任务 < 2s（本地 SQLite + 规则匹配） |
| 性能 | 知识检索注入应快 | 单次注入检索 < 500ms（BM25 + jieba） |
| 稳定性 | 持久化一致 | SQLite WAL + 单写者队列；崩溃后重启状态一致 |
| 稳定性 | 子代理超时/取消 | 取消经 DSH `signal`（终止为 stopReason=`aborted`）；执行超时由 Weave 应用层计时（DSH API 无 timeout 参数）；Weave 不自行 kill |
| 安全 | 非交互模式 | 执行器需用户批准的操作被自动拒绝，拒绝以子代理输出/诊断文本体现；Weave 按 stopReason 正常映射，'permission_denied' 为可选启发式（非 DSH 枚举，不作 P0 强制） |
| 安全 | 执行器资源隔离 | 进程数/频率限流，超限排队不熔断 |
| 安全 | 知识导入安全 | 不执行文档内宏/脚本；文件大小和类型白名单 |
| 可观测性 | 审计日志 | 任务状态变更、反馈、知识状态变更、supersede、ban、team 切换均记录 |
| 可扩展性 | 执行器扩展 | 新 ACP 工具只需注册到 DSH 即可被发现，Weave 侧无硬编码依赖 |
| 可扩展性 | 知识格式扩展 | 新文档类型只需新增 AnyDoc 转换器，不改业务入口 |
| 兼容性 | DSH 版本 | 以 DSH 0.1.1-rc.2（含 ctx.subagents）为基线 |
| 运维 | 配置化 | 团队、角色、执行器、知识注入、反馈均使用 YAML/Markdown 配置 |
| 约束 | 核心无 LLM | P0 调度/校验/路由采用规则驱动，不依赖 LLM 决策 |

---

## 6 边界与范围

### 6.1 范围内（本 FDD 负责）

- P0：团队/角色/执行器、任务 DAG、委托执行、保温期、修订注入、知识导入、AnyDoc 转换、candidate 生成、知识审核（approve/reject，HI-5）、最小知识注入、MCP/CLI、DAG/执行器页面、Obsidian 入口、持久化、多团队隔离。
- P1：完整四层知识体系、人工 supersede 与 deprecated 生命周期、双向反思、知识保鲜、Graphify、Obsidian 双链增强、自定义 CLI 执行器后备。

### 6.2 范围外或暂缓

| 事项 | 决策 | 依据 |
| --- | --- | --- |
| 自研进程管理/SessionLifecycleManager | 不实施 | ADR-032 |
| 通过 `ctx.subagents.start` 之外的自研 subagent 适配 | 不实施 | ADR-030/033 |
| 网页链接导入 | 暂缓 | 附录 C.5 |
| 浏览器插件/浏览器自动化采集 | 暂缓 | 附录 C.5 |
| Obsidian 双向同步 | P0 不做 | 附录 C.3 |
| Graphify 图谱 | P1 实施 | 附录 C.4 |
| 自定义 CLI 执行器 | P1/可选后备 | 架构 3.2 |
| 执行器需要感知 Weave | 不实施 | 设计原则“无侵入” |
| 核心 LLM 调度 | 不实施 | 设计原则“核心无 LLM” |

### 6.3 与架构决策映射

| 架构决策 | FDD 落地 |
| --- | --- |
| ADR-030 执行器调用基于 DSH ctx.subagents 原生 API | F-02/F-05/F-09 执行器发现、统一委托、执行器页面 |
| ADR-031 ephemeral 线程下保温期修订靠上下文注入 | F-06/F-07 保温期、修订上下文注入 |
| ADR-032 删除自研进程管理和 SessionLifecycleManager | F-05/F-17 委托与持久化范围 |
| ADR-033 执行器收敛为四类 | F-02/F-05/F-09 执行器分类与管理 |
| 附录 C.1 知识导入以界面为主 | F-09/F-10/F-11 知识导入与 AnyDoc |
| 附录 C.2 角色学习流程 | F-21 角色学习完整闭环 |
| 附录 C.3 Obsidian 集成 | F-16/F-27 Obsidian 入口与双链 |
| 附录 C.4 知识图谱（Graphify） | F-26 Graphify |
| 附录 C.5 链接与浏览器采集暂缓 | F-29 暂缓项 |
| 附录 C.6 AnyDoc/Graphify 不是执行器 | F-10/F-26 边界 |

---

## 7 验收总览

### 7.1 必须通过的 P0 验收项（17 项；为架构 15.1 的 14 项超集）

> 验收关系：本清单（17 项）为架构 15.1（14 项）的超集——本表第 1-13、17 项对应架构 15.1 全部 14 项（第 17 项 ↔ 架构 15.1 #14），第 14-16 项为知识链路补充验收（知识导入 candidate 生成 / AnyDoc 预览与编辑后确认 / 知识注入限流）；任务规划 DoD 以本清单 17 项全部通过为完成标准。

1. `ctx.subagents.start('spawn'/'fork')` 正常返回；
2. Codex / Claude Code / ACP provider 通过 `ctx.subagents.start` 正常返回（执行器 Bundle 安装并启用后验证；若与 DSH `0.1.1-rc.2` 不兼容，按任务规划方案B 降级：spawn/fork 必过，其余安装后验证）；
3. 修订时 prompt 含上一版输出和用户反馈；
4. 两次调用无状态残留；
5. 非交互模式下需批准操作被拒时，子代理以输出/诊断文本明确说明；Weave 按 stopReason 正常映射（`permission_denied` 为可选启发式识别，不作 P0 强制）；
6. 执行器未注册时团队校验失败；
7. 团队选择优先级链正确；
8. 保温期 → 修订 → 关闭全链路正确；
9. 依赖传播 + 重激活正确；
10. 断路器状态机正确；
11. 进程数限流超限排队不熔断；
12. DAG 面板自动加载；
13. DSH 设置无 Weave 条目；
14. 知识导入支持附录 C 文件类型并生成 candidate；
15. AnyDoc 转换结果可预览并可编辑后确认；
16. 知识检索注入符合限流配置；
17. 崩溃恢复后状态一致。

### 7.2 计划验证方式

- 单元测试：状态机、规则分解、意图识别、检索权重；
- 集成测试：真实 DSH `ctx.subagents` 调用、AnyDoc 转换；
- 手工验收：Web 导入、执行器页面、Obsidian 入口、DAG 面板；
- 故障演练：执行器超时、失败、熔断、限流、进程崩溃。

---

## 8 参考

- `doc/design/架构设计文档.md` v0.2.0（2026-08-24）
- ADR-030 ~ ADR-033
- 附录 A 版本演进摘要
- 附录 B v0.1.0-rc → v0.2.0 变更摘要
- 附录 C 知识导入与角色学习决策摘要
