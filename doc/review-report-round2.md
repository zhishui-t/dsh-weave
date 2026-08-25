# Weave Phase 0 文档审核报告（第 2 轮）

| 元信息 | 内容 |
| --- | --- |
| 审核轮次 | 第 2 轮（最终轮） |
| 审核人 | reviewer（weave-phase0-squad） |
| 审核日期 | 2026-08-25 |
| 审核对象 | 第 1 轮后修订的 5 份文档（架构/FDD/SDD/TDD/04-任务规划）+ 结论文档 P0-ENV-001-spike-conclusion.md、P0-EXEC-021-conclusion.md |
| 前置 | P0-SPEC-API(t17)、P0-SPEC-PLAN(t18)、P0-SPEC-STATE-DAG(t19)、P0-SPEC-KNOW(t20) 已完成 |
| 审核方法 | ① 按 review-report-round1.md §6 的 8 项清单逐条核验（对照修订后文档原文）；② 独立实证复核：DSH 0.1.1-rc.2 类型源（`node_modules/@deepseek-ai/dsh-subagent/lib/types/*.d.ts`）、三 provider 包安装状态、`~/.dsh/profiles/web/cordis.patch.yml`、复跑关键测试（spike 20/20、bundle 11/11、plugin-loading 2/2，共 33/33 绿）；③ 任务图程序化校验（22 任务 / 78 边 / 0 缺失 / 0 多余 / 无环） |

---

## 1 结论（TL;DR）

**允许 5 名开发按修订后的任务规划开始全量编码。** 第 1 轮全部阻塞/高危项均已在文档中修复且具有实证支撑；无剩余阻塞项。附 4 条低优先文字/命名遗留（§5），不阻塞编码，可在迭代中清理。

---

## 2 第 1 轮 §6 复核清单逐条结果

### ① BLK-1 DSH API 契约 — **已修复** ✅

| 修订点 | 证据位置 |
| --- | --- |
| `prompt` 为 `ContentBlock[]`（非 string）；`parent: Agent`、`signal: AbortSignal` 必填 | TDD §1.5.3、§2.4.2；SDD §2.3.4（"prompt 最终以 ContentBlock[]（[{type:'text',text:prompt}]）传入"）；架构 §5.2 代码注释；FDD F-05 |
| `start()` 返回 `SubagentRun`；失败时 `run.result` resolve 不 reject | 三文档（TDD §1.5.3 / SDD §2.3.5 / 架构 §5.2）均写明 `{ id, localAgent?, result: Promise<SubagentResult>, dispose() }` |
| `SubagentTaskOutput` 按真实结果重构（`{ id, output: ContentBlock[], diagnostic?, stopReason, structured? }`；`duration_ms` 由 Weave 自计时） | TDD §2.4.2；SDD §2.3.5 `mapResult(run, result, durationMs)`；架构 §5.2 |
| 错误映射表按 `stopReason` 重写：`completed→COMPLETED`；`aborted→CANCELLED`（不计熔断）；`error/max-tokens/refusal→FAILED`（计熔断）；基础设施 reject→FAILED；应用层 `timeout→FAILED`；`unavailable` 归并为 `executor_unavailable`（委托前拦截）；`cancelled/parse_failed/crash` 废除 | TDD §2.4.3（含层级关系说明 ME-8）；SDD §6.1；架构 §5.5 |
| `permission_denied` 改为可选启发式（输出/诊断文本匹配），明确"不作 P0 强制验收" | 架构 §5.6；SDD §6.1；TDD §2.4.3、§5.4、AC-EXEC-004；FDD §4.9.3、§7.1(5) |
| `ExecutorInfo.capabilities` 改读真实 `SubagentCapabilities`（outputSchema/depthLimit/toolFilter/persona），删除虚构常量 | 架构 §3.1.2；SDD §2.4.2；TDD §1.5.4、§2.4.2；FDD §4.9.3 |

复核对照：与 DSH 0.1.1-rc.2 类型定义逐字段一致；spike（t2）与 bundle（t27）测试输出佐证（见 §4）。

### ② BLK-2 执行器 Bundle / 验收口径 — **已修复** ✅

- 04 任务规划新增 **P0-EXEC-021**（安装/启用三 provider 包、兼容性结论、`list()` 验证），入任务图（P0-ENV-001→P0-EXEC-021→P0-REG-002）、时程、风险表、DoD#3。
- 验收口径两级化：AC-EXEC-001 "spawn/fork 必过；codex/claude-code/acp 在 Bundle 安装并启用后验证；不兼容降级方案B"；FDD F-02、FDD 7.1#2、架构 15.1#2 同步。
- 实证：三包 `0.1.1-rc.2`（**修正第 1 轮 E6 版本判定**：`npm view` latest=0.0.1-rc.1 但同包 dist-tag `next`=0.1.1-rc.2，与基线同版本线、peer 全满足）安装成功并注册，真实 `list()=["codex","claude-code","acp"]`；方案A 成立无需降级。`start()` 端到端冒烟排入 P0-TEST-019 真实环境冒烟（文档已声明）。

### ③ HI-1 工程脚手架 / P0-BOOTSTRAP — **已修复** ✅

- 仓库已成型：`@deepseek-ai/dsh-plugin-weave`（package.json private:true、main→dist/plugins/weave）、tsconfig/tsconfig.build/vitest.config/eslint.config/pnpm-workspace、`src/plugins/weave/` 已含实现与 17 个测试文件、scripts/env-check.mjs、README §1 工程形态说明。
- 04 任务规划：P0-BOOTSTRAP 为全局前置（任务图边 P0-BOOTSTRAP→全部任务）、DoD#2；所有 testCommand 统一前置。
- 实测：`pnpm vitest run` 可运行（本节复核即成功复跑 3 个测试文件）。

### ④ HI-2 14 态 × 32 转移权威矩阵 — **已修复** ✅

- TDD §2.1.5 权威矩阵恰好 **32 行（#1-#32）**，逐一计数验证；含前置条件与副作用列。
- `COOLDOWN` 纳入第 14 态：唯一路径 `BANNED→COOLDOWN→WAITING`（或人工 `COOLDOWN→SKIPPED`），明确禁止"合并入 BANNED 字段"变通；含 #20→#22 定时驱动要求。
- 修订失败路径（ME-5）：#15 `REVISION_RUNNING→FAILED`（previous_result 保留、revision_count 不回退、可 #18 retry 续修）、#16 →CANCELLED。
- 架构 §4.2.2 / FDD §4.4.2 / SDD §2.2.3 三处收敛为同一 32 行矩阵并声明"以 TDD §2.1.5 为唯一权威"；FDD F-04 14 态枚举含 COOLDOWN（LO-1）。

### ⑤ HI-3 DAG 持久化模型 — **已修复** ✅

- TDD §2.6.6 `dags`、§2.6.7 `edges`（PK dag_id+from+to）、§2.6.8 `team_bindings` 表 DDL；`tasks` 增 `dag_id`/`stage` 列（§2.1.2、§2.6.1）。
- `submitTask` 同事务写 dags/tasks/edges + task_sequences 取号；`getDag` 三表联合读取（§1.5.2、§2.6.6 说明）——无进程内状态。
- AC-TASK-009（DAG 持久化验收）；SDD §5.2 与架构 §9.2 对齐（tasks.error_type 注释同步更新）。

### ⑥ HI-4 阶段 → 角色绑定 — **已修复** ✅

- TDD §2.3.2 绑定规则：模板阶段 `s` 按 roles 声明顺序取首个 `s ∈ role.stages` 的角色；结果写 `tasks.assigned_agent`（**角色 id**，执行器经 role.executor 解析——LO-9 术语澄清）+ `tasks.stage`。
- 兜底：无角色声明 → "阶段名=角色 id" 隐式匹配；仍无 → `configuration_error`（不静默跳过，避免 DAG 不完整）。
- `default_difficulty`（缺省 'hard'）处理 matcher 未命中；TeamManager 校验 #6/#7（每角色 stages 非空、每模板阶段至少绑定一角色、dag_templates[default_difficulty] 存在、pattern 合法正则）。
- AC-ROLE-005；04 P0-TEAM-003 关键交付物注明。

### ⑦ HI-5/HI-6 知识转正 P0/P1 + 验收集统一 — **已修复** ✅

- FDD F-23 拆分 **F-23a（P0）**：`weave_knowledge_review/approve/reject` 审核队列、`candidate→active`（approve）/`candidate→deprecated`（reject）、写 knowledge_meta 与审计；**F-23b（P1）**：supersede、deprecated 维护、knowledge_search 作为审核入口。
- 04：P0-KREVIEW-012（P0，审核队列 approve/reject→active）；**P0-KINJECT-013 依赖新增 P0-KREVIEW-012**；关键路径注释"注入数据源为审核后的 active 知识"。
- TDD：AC-KNOW-003（候选→active 生命周期）P0；**AC-KNOW-005 改注 P0（ME-1）**。
- 验收集：FDD §7.1 明示 **17 项 = 架构 15.1（14 项）超集**（第 14-16 项为知识链路补充，17↔15.1#14）；04 DoD 改为"满足 FDD 7.1 全部 17 项（含架构 15.1 全部 14 项）"，§5.5 映射表补超集说明。

### ⑧ ME-1~11 / LO-1~11 逐条 — **全部修复** ✅

| # | 判定 | 证据 |
| --- | --- | --- |
| ME-1 AC-KNOW-005 优先级 | ✅ | TDD AC-KNOW-005 改 P0（注明 ME-1） |
| ME-2 role.knowledgeInjection | ✅ | SDD §2.3.3 `limit: team.knowledge_injection`（P0 无角色级覆盖） |
| ME-3 角色级/执行器级限流 | ✅ | 角色级 `max_concurrent_tasks` = 调度软限制；`executor_limits` = 执行器级硬限制，独立叠加（TDD §1.5.2、SDD §2.2.6/§2.3.3、04 P0-SAFETY-015） |
| ME-4 会话绑定 DDL | ✅ | `team_bindings` 表 DDL（TDD §2.6.8）；team_switch UPSERT（§1.2.6）；selectTeam 优先级链含"提示选择→返回 null 不抛错"（§1.5.1） |
| ME-5 修订失败路径 | ✅ | 转移 #15/#16 + 矩阵说明（上下文保留、可 retry 续修、accept 时 clearRevision） |
| ME-6 限流配置来源 | ✅ | `team.yaml.executor_limits`（SDD §2.1.2、TDD §2.3）；校验 #8；ProcessLimiter 缺省 1/20（SDD 配套支撑表） |
| ME-7 执行器页数据源 | ✅ | TDD HTTP 表 `/weave/executors` 行：provider 列表=list()；进程数/频率=Weave 自计数（ProcessLimiter.status()）；来源=provider 名 |
| ME-8 错误码体系分裂 | ✅ | TDD §1.1.2（对外码）与 §2.4.3（tasks.error_type 持久化值域）层级关系注明；交集项同名同义；unavailable 归并、cancelled 废除 |
| ME-9 AnyDoc 选型 | ✅ | 唯一选型 `@firecrawl/anydoc`，`dsh-plugin-anydoc` 明确不作 Phase 0 选项（SDD §2.6.5/§3、架构 §7.9/§14、FDD §4.2.1）；04 P0-ENV-001 含 anydoc 可安装性验证 |
| ME-10 目录树不一致 | ✅ | SDD §5.1、TDD §2.7 目录树补齐 imports/、anydoc-cache/、graphify-out/（标注 P1 不创建）；与架构 §9.1 一致 |
| ME-11 prompt 承诺 P1 CLI | ✅ | SDD §2.3.4 注明 P0 无知识检索 CLI，不在执行器可用命令中 |
| LO-1 FDD 14 态 | ✅ | FDD F-04 枚举含 COOLDOWN；架构/FDD/SDD 均指向 TDD §2.1.5 |
| LO-2 COMPLETED→CLOSED | ✅ | TDD §1.2.4 仅 AWAITING_FEEDBACK 可 accept；COMPLETED accept → invalid_status_transition |
| LO-3 await list() | ✅ | 文档无残留（仅 spike 结论中描述历史差异）；TDD 注明 list() 同步 |
| LO-4 confidence/created | ✅ | `confidence REAL DEFAULT 0.1`（架构 §9.2、SDD §5.2、TDD §2.6.2）；created=ISO 8601 日期子集（TDD §0.3/§2.2.2） |
| LO-5 preview 返回 | ✅ | `preview(jobId): Promise<{markdown, warnings[]}>`（TDD §1.5.8、SDD §2.6.6）与 HTTP /preview 一致 |
| LO-6 扩展名 | ✅ | 四文档统一显式扩展名（.doc/.docx/.pdf/.ppt/.pptx/.xls/.xlsx/.epub/.csv/.rtf/.odt） |
| LO-7 校验项#4 PATH | ✅ | SDD §2.1.3 第 4 项删除并标注"非 P0 行为" |
| LO-8 capabilities 常量 | ✅ | 改读真实 SubagentCapabilities；无消费方时仅作展示/预留（架构 §3.1.2 注释） |
| LO-9 agent/role 术语 | ✅ | TDD §2.3.2 明确 assigned_agent 存角色 id |
| LO-10 previewing/reviewing | ✅ | TDD §3.1.4 语义说明（previewing=只读预览；reviewing=编辑/确认后生成 candidate；均不写 active） |
| LO-11 入参错误码 | ✅ | 新增 `invalid_argument`（TDD §1.1.2、§1.2.1 SubmitTaskInput 校验映射） |

---

## 3 独立实证复核（本次审核执行的验证）

| 复核动作 | 结果 |
| --- | --- |
| 三 provider 包安装状态（DSH 安装根） | `dsh-subagent-{codex,claude-code,acp}` 均在位 |
| `~/.dsh/profiles/web/cordis.patch.yml` | 含 subagent-codex / subagent-claude-code insert 行（providerName 正确），注释说明 ACP 未启用（需 command）与备份回滚方式；与结论文档一致 |
| 复跑测试（本人执行，非引用他人结论） | `env-subagents-spike.test.ts` **20/20**；`executor-bundle.test.ts` **11/11**（真实 `list() = ["codex","claude-code","acp"]`）；`plugin-loading.test.ts` **2/2** —— 共 3 文件 33 测试全绿 |
| 任务图程序化校验（04 文档 JSON） | 22 任务 / 78 边 / 依赖↔edges **0 缺失 0 多余** / **无环**；P0-TEST-019 依赖其余全部 21 任务；P0-BOOTSTRAP 无依赖（全局前置） |
| 状态矩阵计数 | TDD §2.1.5 与架构 §4.2.2 均恰好 32 条，编号与语义一致 |

---

## 4 残留低优先项（不阻塞，建议顺手清理）

1. **04 §2 BLK-2 注释引用陈旧**：`（审核报告 E6：npm 最新版 0.0.1-rc.1，低于基线）`——该判定已被 P0-EXEC-021 修正（dist-tag next=0.1.1-rc.2 同版本线且安装成功）。建议改为"未安装 + preset 默认禁用"的事实表述，避免误导。
2. **P0-BOOTSTRAP testCommand 文件名不符**：任务规划写 `bootstrap.test.ts`，实际交付为 `plugin-loading.test.ts`。建议改 testCommand 或重命名文件。
3. **AC-EXEC-001 GWT 中 ACP 占位名**：步骤使用 mock 占位名 `zcode`，真实 provider 名为 `acp`。建议注明"zcode（mock 占位名，真实名为 acp，分类规则一致）"。
4. **ACP 生产启用依赖部署配置**：`subagent-acp` 需实际 ACP `command`（结论文档 §4.3 模板已给）。建议在 FDD/04 验收备注中写明"acp 按部署环境配置 command 后启用"，避免 P0-TEST-019 验收时环境差异导致歧义。

---

## 5 最终结论

**允许 5 名开发按（修订后的）任务规划开始全量编码。** 依据：

1. 第 1 轮 2 项阻塞（BLK-1/BLK-2）与 6 项高危（HI-1~HI-6）在本轮全部判定 **已修复**，且 BLK-1/BLK-2 的修复有真实 DSH API 契约、真实安装注册与 33/33 测试绿作为实证；
2. ME-1~11、LO-1~11 共 22 项全部修复；
3. 任务图无环、依赖一致，P0-BOOTSTRAP/P0-EXEC-021 已入图，可执行性成立；
4. 唯一保留的"延后验证"事项为**已显式规划**的：架构 15.1#2 的 `start()` 端到端冒烟排入 P0-TEST-019 真实环境冒烟（文档已声明，属验收时点而非开发阻塞）。

**给编码团队的 3 条提醒**（均已在文档中，此处重申防止踩坑）：
- `ctx.subagents.start()` 的 `prompt` 必须传 `ContentBlock[]`、`parent: Agent`、`signal` 必填；`run.result` 子代理失败时 resolve 不 reject，判失败看 `stopReason`。
- `tasks.error_type` 持久化值域 = DSH stopReason ∪ Weave 应用层码（timeout/permission_denied），与对外错误码（§1.1.2）是两个层次，勿混用。
- `permission_denied` 为可选启发式，**不代表 P0 验收强制项**；验收以 TDD AC 列表（§4.1）与 FDD §7.1 17 项为准。

---

*本报告为第 2 轮（最终轮）审核结论。第 1 轮全部复核项已闭环；如后续文档再修订（尤其是 API 契约或 AC 列表），建议按需单独复核增量变更。*
