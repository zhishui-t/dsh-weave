# 代码调用链图谱（code-map）设计交付摘要

> 交付人：开发工程师-3（长安 · 图谱线）｜日期：2026-08-28
> 产物：`doc/05-反思沉淀与技能落地-优化设计文档.md` 新增 **§8 代码调用链图谱设计**（含 §8.6 实施任务清单 T59–T65）
> 本轮仅改文档；验证：`pnpm typecheck` exit 0（见文末）。

## 一、设计结论速览（五项选型）

| # | 决策点 | 结论 | 一句话理由 |
| --- | --- | --- | --- |
| ① | 静态扫描 | **自写轻量 import 解析**（否决 madge / dependency-cruiser） | 生产源码仅 51 个 ts/tsx，NodeNext ESM 相对导入带 `.js` 后缀、无 paths alias——三条正则 + 后缀探测即覆盖；零新依赖、纯函数可直测。dependency-cruiser 的规则能力登记为三阶段可选引入点 |
| ② | 图数据形态 | **模块级为本期**（文件→文件带导出符号 + 依赖深度分层）；函数级为可选二阶段（边界登记） | 分层与 DAG `computeDagLevels` 完全同构（列=level），`compactDagLayout` 数学零改动移植；函数级需 TS AST 符号解析，成本高一个数量级，等用户反馈再立项 |
| ③ | 存储与查询 | **独立 code-graph 缓存 + RPC 为主干，知识摘要条目为辅**（两方案各取一半） | 全图 JSON 塞知识条目与知识模型错配；纯独立 RPC 则执行器看不见模块地图。缓存 = state 目录 `code-map.json`（mtime+size 指纹判 stale）；端点 `code/graph` + `code/chain`（上下游闭包/两点路径——"快速看调用链"核心查询）；辅路径 = 每轮扫描产一条 `type=doc, source:code-map` project 层候选知识（只装摘要不装全图），审核转正后注入开发角色 |
| ④ | UI | **控制台顶层新增「代码图谱」路由**，SVG 同构渲染 | client `ROUTES` 增 `code` 页；渲染仿 KnowledgeGraphView（svg viewBox 自适应），布局复用 compactDagLayout/relatedDagTaskIds 同构移植；悬停聚焦+点击固定+Esc、文件名过滤闭包子图、详情卡+调用链高亮；testid 锚点 `code-graph` / `code-node-*` / `code-edge-*` / `code-graph-detail` / `code-chain-result` |
| ⑤ | 刷新策略 | **构建后一键 `pnpm code:scan`（主）+ RPC 缓存 miss 惰性兜底（辅）**（否决 watch 常驻 / 每次 RPC 现扫） | 变更点=编译期，build 后扫一次即保新鲜；兜底单飞防并发重扫；51 文件全量重建 <100ms，不做增量解析 |

## 二、实施任务清单（T59–T65，编号与 doc/06→T4、doc/07→T32、任务池→T58 无冲突）

| # | 任务 | 角色 | 依赖 | 文件所有权（关键文件） | 验证命令 |
| --- | --- | --- | --- | --- | --- |
| T59 | 扫描器纯函数（import 解析+分层+环检测）+ 单测 | developer-1 | — | `code-map/code-scanner.ts`（+测试） | `pnpm vitest run src/plugins/weave/__tests__/code-scanner.test.ts` + `pnpm typecheck` |
| T60 | 指纹缓存 store + CLI + `pnpm code:scan` | developer-2 | T59 | `code-map/code-map-store.ts`、`cli.ts`、package.json scripts 一行 | `pnpm vitest run .../code-map-store.test.ts` + `pnpm code:scan`（约 51 文件量级核对）+ `pnpm typecheck` |
| T61 | `code/graph` / `code/chain` RPC 端点 + 惰性兜底单飞 | developer-3 | T60 | `web/query-service.ts`、`rpc.ts`（如需）、query-service 测试（追加） | `pnpm vitest run .../query-service.test.ts .../code-graph-query.test.ts` + `pnpm typecheck` |
| T62 | 知识摘要条目（type=doc/source:code-map，幂等单条） | developer-1 | T59 | `code-map/summary-entry.ts`（不碰 reflection-service/knowledge-model） | `pnpm vitest run .../code-map-summary.test.ts` + `pnpm typecheck` |
| T63 | client「代码图谱」视图（SVG 分层+聚焦+过滤+链高亮） | frontend-1 | T61 | `src/client/index.ts`、client-bundle 测试（追加不改既有断言） | `pnpm build` + `pnpm vitest run .../client-bundle.ui.test.tsx` + `pnpm typecheck` |
| T64 | e2e harness（真实页面渲染/聚焦/过滤锚定） | tester-1 | T63 | `e2e/harness/code-graph.spec.ts`（新增） | `pnpm test:e2e:harness` |
| T65 | QA 全量回归 + §8 设计-实现一致性检视（收尾闸门） | qa | T59–T64 | 新增 `doc/review-report-code-map.md` | `pnpm vitest run` + `pnpm typecheck && pnpm lint` + `pnpm test:ui` + `pnpm code:scan && pnpm test:e2e:harness` |

并行度：T59/T60/T61 主干串行；T62 与 T59 同人不同文件（T59 后即可并行）；T63 等 T61；T64/T65 收尾。
派单纪律对齐队长协作六律⑥：前端归 frontend-\*、测试归 tester-\*、回归归 qa，人员均衡。

## 三、本轮改动与验证

- 改动：仅 `doc/05-反思沉淀与技能落地-优化设计文档.md`（头部修订记录 + 新增 §8 全节，插于 §7 与附录 A 之间）；另新增本摘要 `output/code-map-design-tasks-summary.md`。
- 验证：`pnpm typecheck` → exit 0（纯文档改动，无代码触碰）。
