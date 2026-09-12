# Prism 接入架构（知识能力移交）

> 状态：已实施（P1）
> 日期：2026-09-12
> 关联：weave `master_prism_0912` 分支；prism 子项目（同级 `../prism`，master）

## 1. 定位与边界

**weave = 调度运行时**：主会话/队长、DAG 调度、委托执行、治理（状态机/熔断/审计）、ACP 会话接入。

**prism = 知识与协作控制面**：知识存储/检索、知识图谱、代码图谱、文档转换、Obsidian 导出；后续（P2/P3）承接角色团队定义与任务台账。

判定标准：**凡是"知识数据"的持有与加工都在 prism；weave 只在调度闭环里"碰"知识**——派发前取一次上下文（HTTP）、执行器输出里的反思块解析入暂存区、DAG 收敛后发一次建图触发。weave 不做任何检索/排序/存储逻辑。

## 2. 通道分工（定案）

| 用途 | 通道 | 说明 |
| --- | --- | --- |
| 派发注入（保证性上下文） | weave → prism **HTTP**（`GET /api/kb/search`） | weave 是拼 prompt 的宿主进程，非 MCP 会话；一次调用，prism 排序返回，weave 只拼模板 |
| agent 执行中查知识 | agent → prism **stdio MCP**（`prism_kb_*` 等 36 工具） | weave 把 prism MCP 注入每个 ACP 会话的 `mcp_servers` |
| 主会话审核 | `/weave knowledge review\|approve\|reject` CLI | 操作 weave 暂存区（prism 原生工具看不到暂存区） |
| 图谱构建触发 | weave → prism **HTTP**（`POST /api/graph/build` + job 轮询） | 团队启动/任务结算的薄触发，失败不阻断 |
| 文档转换 | prism CLI（`kb convert`，无 HTTP 路由） | weave_document_convert 工具薄代理 |
| Web 界面 | **prism 控制台**（`http://127.0.0.1:7777/studio`） | weave dashboard 的 knowledge 页为占位卡外链 |

P2 角色迁移后，派发注入可平滑升级为 prism context-pack（角色知识绑定 + token 预算）。

## 3. 反思与审核闭环（先审后发）

```
执行器输出（WEAVE_KNOWLEDGE 块）
  → PrismReflectionService（解析，移植自旧 knowledge/reflection.ts）
  → KnowledgeStaging 暂存区（~/.dsh/state/knowledge-staging/，文件制 JSON）
  → DAG 收敛时 scheduler 通知队长「N 条沉淀待审」
  → 主会话 /weave knowledge review → approve（prism deposit 即生效，版次制）/ reject（删除）
```

- prism 的 deposit 没有待审态（即落即生效），"先审后发"由 weave 暂存区兑现——**审核是治理动作所以队列归 weave，知识本体归 prism**。
- 暂存条目映射：type pitfall/pattern/skill→guide/doc；book=`weave-execution`；module=type；layer=project，owner=projectId；tags 追加 `executor:*`、`role:*`、`source:weave-reflection(-auto)`。
- 审计：暂存发 `knowledge.status_changed`（reflection→candidate）；approve 发 `knowledge.deposited`；reject 发 `knowledge.status_changed`（candidate→rejected）。

## 4. 内嵌形态（一个插件整体）

- weave 插件 `apply()` 时由 `PrismSupervisor` 确保内嵌 prism serve 运行：已有健康实例则复用；否则用宿主同款 node 拉起子进程（`PRISM_HOME` 默认 `~/.dsh/prism`），探活 `/api/health`。
- 脚本解析：`WEAVE_PRISM_SCRIPT`（serve 入口）/ `WEAVE_PRISM_MCP_ENTRY`（MCP 入口）> dev 约定 `../prism/packages/{cli,server}/dist/**`。打包部署时由构建流程 vendor prism 发行布局并设 `WEAVE_PRISM_SCRIPT`。
- 失败降级：宿主 Node < 22.5（prism 依赖 node:sqlite）或未找到入口时，知识/图谱能力降级为不可用并告警，**绝不阻断调度主链路**。
- 设置（`~/.dsh/weave/settings.json`）：`prism_base_url`（默认 `http://127.0.0.1:7777`）、`prism_home`（默认 `~/.dsh/prism`）。

## 5. 已删除（weave 侧）

- 模块：`knowledge/`（模型/引擎/审核/导入/UI）、`graph/`、`convert/`、`obsidian/`、`mcp/knowledge-mcp.ts`、`web/knowledge-graph.ts`
- SQLite：`knowledge_meta.db`、`imports.db`（旧库文件原地保留不再打开）；recovery 的导入/知识对账移除
- MCP 工具：`weave_knowledge_search/review/approve/reject`（agent 用 `prism_kb_*`；审核走 /weave CLI）、`weave_obsidian_*`
- RPC 端点：`knowledge/*`、`code/*`、`document/*`、`obsidian/*`
- Web 客户端：KnowledgePage/CodeGraphPage/DocumentConvertPage/ObsidianPage 四页与相关类型/样式
- 依赖：`@firecrawl/anydoc`、`@sentropic/graphify`、`code:scan` 脚本
- 设置键：`knowledge_dir`、`obsidian_dir`

接受的功能收缩：Obsidian 指纹/冲突矩阵（weave 版独有）随模块下线，prism 侧为导出式同步；如需补齐在 prism 仓库演进。

## 6. 后续阶段（未实施）

- **P2 角色团队**：`~/.dsh/teams/*.yaml` 迁 prism roles/teams；team-runtime 从 prism 拉定义（`prism_team_activate` / `/api/roles|teams`）；注入升级 context-pack（角色知识绑定）。
- **P3 任务台账**：任务完成/结算镜像 prism task center（`prism_task_*`）；live DAG 状态仍归 weave。
- **数据迁移**（可选一次性脚本）：`~/.dsh/knowledge` markdown 卡片 frontmatter → prism deposit；当前部署无存量数据。
