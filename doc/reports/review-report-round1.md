# Weave Phase 0 文档审核报告（第 1 轮）

| 元信息 | 内容 |
| --- | --- |
| 审核轮次 | 第 1 轮（共 2 轮上限） |
| 审核人 | reviewer（weave-phase0-squad） |
| 审核日期 | 2026-08-25 |
| 审核对象 | 架构设计文档 v0.2.0、FDD v0.2.0、SDD v0.2.0、TDD v0.2.0、04-任务规划文档 v0.2.0 |
| 审核方法 | ① 五文档交叉一致性比对（接口/状态/错误码/模块命名/优先级）；② 本地实证：对照真实 DSH 0.1.1-rc.2 安装（`D:\Program Files\deepseek\node_modules\@deepseek-ai\`）核对 `ctx.subagents` API 契约与执行器 provider 包；③ 仓库现状核查（`/k/work/project/weave`） |
| 结论 | **不允许按现任务规划直接全量编码**；需先完成第 2 轮规格修订（详见 §6），同时可先行启动 P0-ENV-001 spike 与新增的 P0-BOOTSTRAP。 |

---

## 1 总体判断

五份文档**内部自洽性较好**：优先级链、保温期参数（1800s / 86400s / max_revisions=5）、知识注入限制（5 条/500 字/2500 字）、置信度模型（0.1 起步、±0.15、阈值 0.75）、四类执行器分类、ADRs 引用、任务图 JSON 与依赖表格（抽查无环且一致）在各文档间高度一致。架构→FDD→SDD→TDD 的覆盖关系清晰，TDD 的 AC 列表可追溯到 FDD 与架构 15.1。

但**外部契约（真实 DSH API）与本规格存在系统性不符**，且存在多处影响 Phase 0 主链路的规格缺口与 P0/P1 范围冲突。若按现规格编码，`DelegationService`（P0-DELEG-007）及以其为地基的任务将大面积返工。

---

## 2 本地实证发现（环境事实，非推断）

在 `D:\Program Files\deepseek`（DSH 0.1.1-rc.2，`package.json` 确认）中实测：

| # | 事实 | 与规格的关系 |
| --- | --- | --- |
| E1 | `@deepseek-ai/dsh-subagent@0.1.1-rc.2` 存在，`Context` 注入 `ctx.subagents`；提供 `list(): string[]`、`start(name, request)`、`registerProvider()`、`getProvider()`、事件 `subagent/provider-added` / `provider-removed` | ✅ `ctx.subagents.list()` / `.start()` 名称与规格一致 |
| E2 | **`SubagentStartRequest.prompt` 类型是 `ContentBlock[]`，不是 `string`**；`parent: Agent`、`signal: AbortSignal` 均为必填（参考 `lib/types/types.d.ts` 与 `lib/types/index.d.ts`） | ❌ 规格 SDD 2.3.3 / TDD 2.4 `SubagentRequest { prompt: string }` 不符 |
| E3 | **`start()` 返回 `SubagentRun`**：`{ id, localAgent, result: Promise<SubagentResult>, dispose() }`；`SubagentResult` 为 `{ output: ContentBlock[], structured?, diagnostic?, stopReason }` —— **没有 `stdout` / `stderr` / `summary` / `duration_ms`** | ❌ 规格 `SubagentTaskOutput { success, stdout, stderr, summary, duration_ms, error_type }` 无对应来源 |
| E4 | **`stopReason` 枚举只有**：`completed` / `aborted` / `error` / `max-tokens` / `refusal`；`run.result` 子代理失败时 **resolve**（stopReason='error'），不 reject | ❌ 规格错误映射表（架构 5.5 / SDD 6.1 / TDD 2.4 / FDD F-05）中的 `timeout` / `execution_failed` / `permission_denied` / `parse_failed` / `crash` / `unavailable` 在 DSH API 中**不存在对应枚举**，无法按规格映射 |
| E5 | `SubagentCapabilities` 为 `outputSchema / depthLimit / toolFilter / persona` | ❌ 规格 `ExecutorInfo.capabilities`（`supports_feedback_loop / non_interactive / ephemeral_session`）无 API 数据源，且当前实现为全同常量 |
| E6 | **`dsh-subagent-codex` / `dsh-subagent-claude-code` / `dsh-subagent-acp` 未安装**；npm registry 上最新版均为 `0.0.1-rc.1`（低于 DSH 基线 `0.1.1-rc.2`）；DSH 默认 preset（`config/agent-presets/standard/agent.cordis.yml`）中 `tool-subagent-codex` / `tool-subagent-claude-code` 标注 `disabled: true`，注释明确"Production dsh does not install these optional providers" | ❌ "四类执行器"在基线环境最多只能验证 `spawn` / `fork`（`dsh-subagent-spawn-in-process` / `-fork-in-process` 已安装且默认启用） |
| E7 | 仓库 `/k/work/project/weave` 只有 `doc/` 与 `.agent-teams/`：**无 `package.json`、无 `src/`、无 tsconfig/vitest/eslint 配置**；DSH 插件实际交付形态为 npm 包（`node_modules/@deepseek-ai/dsh-*`）+ cordis 配置，而非仓库内 `src/plugins/weave` 目录 | ❌ 任务规划全部 `testCommand`（`pnpm vitest run src/plugins/weave/__tests__/...`）无执行环境；插件工程形态未定义 |
| E8 | `@firecrawl/anydoc` / `dsh-plugin-anydoc` 均未安装于基线环境，且文档未定唯一选型 | ❌ P0-ANYDOC-010 前置依赖未落地 |

---

## 3 问题清单（按阻塞 / 高 / 中 / 低分级）

### 3.1 阻塞级（不修复则核心链路按规格不可实现）

**BLK-1｜DSH API 契约与规格系统性不符（E2-E5）**
- 表现：prompt 类型、返回结构、错误码/终态映射、能力模型四处均与真实 API 不符；`SubagentTaskOutput` 是虚构类型。
- 波及：P0-DELEG-007、P0-ENV-001、P0-TEAM-003（校验）、P0-KINJECT-013（注入经 DelegationService）；AC-EXEC-001/004/005；F-05；SDD 6.1/TDD 2.4 错误映射表；架构 5.2-5.5。
- 后果：按现规格实现 `mapResult` / `SubagentTaskOutput` 属于空转，AC-EXEC-004（`permission_denied`）在 stopReason 中没有承载机制（非交互拒绝发生在子代理内层，仅以 child 输出或 `error` 结束出现，规格未定义识别方法）。
- 建议：以 DSH 源码为准重写 TDD 2.4 / SDD 2.3 / 架构 5.x 契约：`prompt` 由 `buildPrompt` 产物转 `ContentBlock[]`；`SubagentTaskOutput` 改为 `{ id, output, diagnostic, stopReason, duration_ms? }`（时长可由 Weave 计时）；错误映射表改为 stopReason → 任务终态 + 附加诊断规则（`aborted`→CANCELLED；`error`→FAILED；`max-tokens`→FAILED；`refusal`→FAILED 或单列）；`permission_denied` 改为"子代理输出/诊断文本启发式识别（可选）"或删除该 error_type 在 P0 的强制要求；`ExecutorInfo.capabilities` 改为读取真实 `SubagentCapabilities` 或删除。

**BLK-2｜"四类执行器"验收在基线环境不可达成（E6）**
- 表现：Codex / Claude Code / ACP provider 包未安装、版本落后（0.0.1-rc.1 vs 0.1.1-rc.2）、默认 preset 禁用；任务规划与验收（AC-EXEC-001、架构 15.1 第 2 项"Codex / Claude Code / ACP provider 通过 ctx.subagents.start 正常返回"、F-02/F-15）未包含安装/启用步骤，也没有"缺失时如何降级"的验收口径。
- 建议（二选一，须在开发启动前决策）：
  - 方案 A：任务规划新增"执行器 Bundle 安装与启用"任务（安装 3 个 provider 包、验证与 0.1.1-rc.2 兼容、更新 agent preset），P0-ENV-001 中验证 list() 是否出现 codex/claude-code/acp；
  - 方案 B：验收口径降级为"spawn/fork 必过；codex/claude-code/acp 为可选 Providers，安装后验证"，并同步修订 AC-EXEC-001、F-02、架构 15.1#2、任务规划 DoD。

### 3.2 高级（影响 P0 主目标，须第 2 轮修订）

**HI-1｜仓库/插件工程脚手架缺失（E7）**：无 package.json/tsconfig/vitest/eslint；DSH 插件交付形态（独立 npm 包 `@deepseek-ai/dsh-plugin-weave`？还是其它）未定义；任务规划的 `src/plugins/weave/__tests__/` 路径缺乏依据。→ 新增 P0-BOOTSTRAP（脚手架 + vitest + 示例插件加载冒烟），并在第 2 轮明确工程形态。

**HI-2｜14 态 × 32 条转移缺少权威矩阵**：架构 4.2.2 / FDD 4.4.2 / SDD 2.2.3 的状态图仅约 28 条边；TDD 2.1.1 的 `TaskStatus` 含 `COOLDOWN` 但无任何进出转移；FDD F-04 枚举（13 态）与 TDD（14 态）不一致。P0-STATE-005 的"32 条转移覆盖"无判据。→ 第 2 轮给出完整转移矩阵（含 COOLDOWN 处置：纳入任务态或仅作熔断态），三文档统一。

**HI-3｜DAG / 任务持久化模型缺失**：`tasks` 表无 `dag_id` 列；无 `dags` / `edges` 表 DDL；`TaskDag.dag_id`、`getDag(dagId)`、FDD F-03"DAG 可持久化、可查询"均无落点。→ 补充 `dags` 表（或 tasks 增加 dag_id + edges 表）DDL 并同步 SDD/TDD/架构 9.2。

**HI-4｜DAG 阶段 ↔ 角色绑定缺失**：`dag_templates` 阶段名（design/implement/test/review/integrate/prepare/deploy/execute）与 `team.yaml` 角色 id（designer/coder/reviewer）无映射机制，`Orchestrator.runReadyTasks` 无法决定任务由哪个角色/执行器执行；`matchers` 无命中时的兜底难度未定义（样例匹配规则只覆盖 critical/medium/easy，`hard` 模板无对应 matcher）。→ 定义"阶段 → 角色"绑定规则（如角色增加 `stages: [design,...]` 字段或阶段名=角色 id 的映射表）与默认难度。

**HI-5｜知识 candidate→active 转正：P0/P1 归属冲突**：FDD 3.3 F-23（approve/reject/supersede）= P1，FDD 4.6.1 P0 仅到"进入审核流程"；但任务规划 **P0-KREVIEW-012（P0）**交付"审核队列、approve/reject、candidate→active"；TDD AC-KNOW-003（candidate→active 生命周期）= P0。若 P0 无 approve，则 **F-12 / AC-ROLE-002 / P0-KINJECT-013 无 active 知识可注入**，知识轨道 P0 目标自相矛盾。→ 裁定（推荐：P0 含人工 approve/reject 审核队列，supersede / 置信度 / 保鲜留 P1；同步修正 FDD F-23 拆分、FDD 4.6.1、角色-功能矩阵与任务规划范围）。

**HI-6｜验收标准集不统一**：架构 15.1 为 14 项，FDD 7.1 为 17 项（多出知识导入/candidate/注入限制/崩溃恢复 4 项内容），任务规划 DoD 只锚定"15.1 全部 14 项"且 5.5 映射表只映射 14 项。→ 合并为单一验收清单（或明确 FDD 7.1 为超集并写入 DoD）。

### 3.3 中级（须在第 2 轮明确或修正）

- **ME-1** TDD AC-KNOW-005（注入限制）标注 P1，但 FDD F-12 为 P0 且任务规划 P0-KINJECT-013（P0）最小通过标准引用 AC-KNOW-005——优先级标注相互矛盾 → 统一（推荐 P0）。
- **ME-2** SDD 2.3.3 伪代码 `limit: role.knowledgeInjection` 引用不存在的字段：`knowledge_injection` 是团队级配置（TeamConfig），`RoleConfig`（TDD 2.3）无该字段 → 改传 `team.knowledge_injection` 或定义角色级覆盖。
- **ME-3** 角色级 `max_concurrent_tasks` 与执行器级 `ProcessLimiter`（key=executorId）关系未定义；样例中 designer/reviewer 同用 `codex`，角色级限制无法由执行器级 limiter 表达 → 定义分层限流或明确角色级仅作调度提示。
- **ME-4** 会话绑定（team switch）持久化无 DDL：TDD 1.2.6 说"持久化到核心状态"，但 `core.db` 只有 task_sequences/bans/failure_counters；`selectTeam` 优先级链"提示选择"分支的 API 行为（抛错？返回 null？）未定义。
- **ME-5** 修订失败路径未定义：`REVISION_RUNNING` 仅有 → COMPLETED；修订执行失败/超时后任务状态与修订上下文（上一版输出是否保留）去向不明。
- **ME-6** 执行器限流配置来源未定义：`ProcessLimiter` 的 per-executor 并发上限与小时频率（执行器页面示例"每小时 8/20"）无配置 schema；`team.yaml` 仅角色级并发，`executors.yaml` 为非 P0。
- **ME-7** 执行器页面数据源缺失："运行中进程数/每小时频率"在 `ctx.subagents.list()`（仅返回名称）与 `SubagentRunInfo` 中无对应字段 → 需 P0-ENV-001 确认或定义降级展示（频率由 Weave 自计数）。
- **ME-8** 错误码体系分裂：TDD 1.1.2 通用错误码表与 2.4 `error_type` 枚举是两个集合（1.1.2 缺 `execution_failed`/`cancelled`/`unavailable`），`tasks.error_type` 存哪个集合未定 → 统一或注明层级关系。
- **ME-9** AnyDoc 选型未定（`@firecrawl/anydoc` 或 `dsh-plugin-anydoc` 二选一，E8）→ 指定唯一选型并列入 P0-ENV-001 验证。
- **ME-10** 目录树不一致：架构 9.1 含 `imports/`、`anydoc-cache/`、`graphify-out/`，SDD 5.1 / TDD 2.7 缺前两者、`graphify-out/`（P1 产物）混在 P0 树；TDD 建议的 `state/imports.db` 未在架构登记 → 三文档统一目录清单。
- **ME-11** P0 委托 prompt 承诺 `/weave knowledge search`（CLI 标记 P1），P0 阶段该命令不存在 → 从 P0 prompt 模板移除或降级为 P0。

### 3.4 低级（建议一并修订）

- **LO-1** FDD F-04 状态枚举（13 态）与 TDD 2.1.1（14 态，含 COOLDOWN）不一致。
- **LO-2** TDD 1.2.4 `accept` 允许 `COMPLETED` 确认关闭，但状态机无 `COMPLETED → CLOSED` 转移 → 限制为 `AWAITING_FEEDBACK` 或补入矩阵。
- **LO-3** 规格多处 `await ctx.subagents.list()`，实际 `list()` 为同步方法（无害但易误导）。
- **LO-4** `knowledge_meta.confidence DEFAULT 0.0` 与文档"初始 0.1"不一致；frontmatter `created: YYYY-MM-DD` 与 TDD 0.3"时间字段统一 ISO 8601"冲突。
- **LO-5** `ImportPipeline.preview` 返回类型：SDD `Promise<string>` vs TDD HTTP `/preview` 返回 `{ markdown, warnings[] }`。
- **LO-6** 白名单"Excel"/"PPT"未明确扩展名（.xls/.xlsx/.ppt/.pptx）。
- **LO-7** 架构 4.1.2 / SDD 2.1.3 校验表第 4 项（非 P0 自定义 CLI 的 PATH 校验）混在 P0 校验表。
- **LO-8** `ExecutorInfo.capabilities` 当前为全同常量且无消费方；按 BLK-1 修订后若无消费方则删除。
- **LO-9** `agent` 与 `role` 术语混用（熔断检查顺序的 `agent+project`、`tasks.assigned_agent` vs `team.yaml roles`）。
- **LO-10** 导入状态机 `previewing → reviewing` 两态语义重叠未说明。
- **LO-11** `SubmitTaskInput` 参数缺失类错误的错误码映射未覆盖（1.2.1 仅写了 `invalid_team` / `configuration_error`）。

---

## 4 肯定项（保持）

1. 五文档对保温期（1800s）、reopen 窗口（86400s）、max_revisions=5、知识注入上限、置信度模型、检索权重、团队优先级链、错误映射主体（cancelled 不计熔断、unavailable 计 FAILED 不计熔断）跨文档一致。
2. 任务规划 JSON 任务图与 §2 表格的 dependsOn/edges 一致、无环；关键路径与并行轨道划分合理；风险表（尤其 P0-ENV-001 对 API 形态风险的预判）方向正确。
3. ADR-030~033 与附录 C 在架构/FDD/SDD/TDD 的引用链完整；"AnyDoc/Graphify 不是执行器"边界四文档一致。
4. 真实 DSH 0.1.1-rc.2 中 `ctx.subagents` 服务、`list()`/`start()` 名称、provider 注册机制（effect 作用域、HMR 安全）与规格设想一致——架构的总体方向（复用 DSH 原生子代理）可行。

---

## 5 结论：是否允许按任务规划开始全量编码

**不允许直接开始全量编码。** 理由：

- **BLK-1** 使 P0 核心任务 P0-DELEG-007 及其下游（P0-KINJECT-013、P0-CLI-014、P0-FEEDBACK-008 的修订执行）在现规格下无法正确实现，且 AC-EXEC-001/004、F-05、架构 15.1#2#5 验收标准无效；
- **BLK-2** 使"四类执行器"验收目标在基线环境不可达，需先做计划级决策；
- **HI-1~HI-5** 分别影响任务规划的启动条件（脚手架）、P0-STATE-005、P0-DB-004/Orchestrator、调度分配、知识轨道 P0 范围，其中 HI-5 与 FDD 的 P0/P1 划分直接冲突。

**放行边界（可立即执行的部分）**：

1. **P0-ENV-001（真实环境 spike）立即启动**——其本身就是"先验证后实现"任务；在 DSH 0.1.1-rc.2 中输出：`list()` 实际 provider 名、`start()` 真实请求/返回样例（ContentBlock、SubagentRun/Result、stopReason）、codex/claude/acp provider 包在当前版本的可安装性与兼容性结论、"permission_denied"在非交互模式下如何显现的实证。**spike 结论回写 TDD/SDD/架构后再放行其余执行器链路任务。**
2. **新增 P0-BOOTSTRAP 任务**（仓库/插件工程脚手架 + vitest/tsconfig/eslint + 最小插件加载冒烟），作为所有 testCommand 的前置。
3. **P0-DB-004、P0-KBLD-009、P0-SESSION-006、P0-AUDIT-016、P0-DAG-017** 可在 HI-2/HI-3 修订后并行启动（纯逻辑/持久化，不受 BLK-1 的 API 契约影响）。
4. **其余任务（P0-STATE-005、P0-SAFETY-015、P0-DELEG-007、P0-FEEDBACK-008、P0-ANYDOC-010、P0-KUI-011、P0-KREVIEW-012、P0-KINJECT-013、P0-CLI-014、P0-RECOVERY-018、P0-DASH-020、P0-TEST-019）等待第 2 轮规格修订后启动。**

---

## 6 第 2 轮需复核的问题清单

第 2 轮将复核以下问题是否已在文档中修复（逐条验证）：

| 复核项 | 对应问题 | 验证方式 |
| --- | --- | --- |
| 1. SubagentStartRequest / SubagentRun / SubagentResult / stopReason 映射 / capabilities 已按真实 DSH API 修订（含 `permission_denied` 承载机制） | BLK-1 | 对照 DSH `dsh-subagent/lib/types/*.d.ts` 逐字段比对 TDD 2.4 + SDD 2.3 |
| 2. 执行器 Bundle 安装/启用步骤（或验收降级口径）已写入任务规划与 AC | BLK-2 | 检查任务清单出现安装任务；AC-EXEC-001/架构 15.1#2 表述 |
| 3. 仓库/插件工程形态与 P0-BOOTSTRAP 已补齐 | HI-1 | 任务规划含脚手架任务；工程形态有定义 |
| 4. 14 态 × 32 转移完整矩阵已给出且 FDD/SDD/TDD 一致（含 COOLDOWN 处置） | HI-2 | 矩阵逐条计数 = 32；三文档枚举一致 |
| 5. DAG 持久化模型（dag_id / dags / edges DDL）已补齐 | HI-3 | SDD 5.2 + TDD 2.1.4 含新表 DDL |
| 6. 阶段→角色绑定规则与 matcher 兜底难度已定义 | HI-4 | 配置模型含映射字段/规则；默认难度有定义 |
| 7. 知识转正 P0/P1 归属已收敛；P0-KINJECT-013 依赖 P0-KREVIEW-012 | HI-5/6 | FDD F-23/F-21 与任务规划范围一致；任务图依赖已更新 |
| 8. ME-1~ME-11 逐条落实 | ME-* | 逐条复核修订后的文档 |

> 说明：本报告为第 1 轮审核结论。第 2 轮审核应在上述修订完成后进行；若修订未完成，第 2 轮将维持"不允许全量编码"的结论并说明具体未修复项。
