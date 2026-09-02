# Weave UI 自动化测试报告

> 测试工程师 1 ｜ 日期：2026-08-28 ｜ 结论：**通过**（harness 54/54 全绿 + live 10/10 全过）

## 1. 交付物

| 项 | 说明 |
| --- | --- |
| `test/e2e/harness/`（6 spec + fixtures，54 用例） | stub RPC 确定性层：虚拟域 `https://weave.test` + ModuleLoader 桩 + `__WEAVE_RPC__` 信封注册表；被测对象为 `dist/client/index.js` 真实构建产物。CI 常驻，无需真实服务器。`pnpm test:e2e:harness` |
| `test/e2e/live/console-live.spec.ts`（10 用例） | 真实 127.0.0.1:3080 无 mock 层；env 门控 `WEAVE_E2E_LIVE=1` + 服务器可达探测，未启用时 10 skipped（exit 0）。`WEAVE_E2E_LIVE=1 pnpm test:e2e:live` |
| `test/e2e/helpers.ts` | 保留 BASE_URL/observe/shot/ROUTES 约定；截图/报告目录迁至 `.artifacts/weave-ui/test/e2e/`；新增 `LIVE_ENABLED`/`probeServer` |
| `playwright.config.ts` | 新增 `forbidOnly`；outputDir 经 ART 迁至 `.artifacts/weave-ui/test/e2e/artifacts` |
| 清理 | 删除 e2e 根目录 10 个零散探针（硬编码文案、一次性诊断，价值已收编进新套件）与旧 `harness/console-harness.spec.ts`（拆分为 6 个 spec） |

## 2. 覆盖范围（对照任务四项）

**① 会话面板**（`session-panel.spec.ts` + `session-dag.spec.ts`，14 用例）
- 团队头：绑定名直显 / `resolved_via≠binding` 带（自动）标注 / 未绑定空态且不发起任务请求
- 成员卡实时状态：`member-card-<roleId>` 的 data-status、状态文案、dot tone（run/idle/bad）；空闲超时中断红色警示
- 任务列表：成员任务 chips `member-assignments-*` 数量与 data-state 对账；运行总览 `weave-session-team-stats` 与进度分段
- DAG 页签交互：默认派生选中、点击迁移选中、详情区切换
- 治理动作矩阵严格等于 `TASK_ACTIONS_BY_STATUS`（RUNNING/AWAITING_FEEDBACK/FAILED/INTERRUPTED/CLOSED/COMPLETED 六态断言）；cancel confirm 门径（dismiss 不发请求）；accept 直发；revise 反馈弹窗 payload 带 feedback；动作后刷新
- 布局：左右折叠/展开、任务区折叠、成员区折叠、刷新补偿重新拉取

**② 控制台七页**（`shell-nav.spec.ts` + `console-pages.spec.ts`，17 用例）
- 可达性：七页逐一 `page-*` 可见 + `nav-*` data-active 唯一；nav-tasks/nav-sessions 不复活
- 空态：teams/knowledge/audit 空数据 → `page-empty`
- 真实 RPC 信封：成功 `{ok,value}` 渲染对账（overview 六卡数字、settings 键值、audit 事件、executors 卡）；失败 `{ok:false,error}` → `page-error` 含 `code: message`；未注册端点 no-mock 防漏测
- 交互载荷：audit 过滤表单提交携带 order；knowledge approve 直发 / reject 两步流 / 过滤重查；settings 目录编辑 → `settings/update`

**③ DAG 图（对齐后紧凑实现）**（`dag-graph.spec.ts`，9 用例）
- 节点：92×30 固定几何、短 ID、状态标签+执行者、状态点颜色映射（RUNNING 蓝/COMPLETED 绿/FAILED 红）
- 贝塞尔边：`M x1 y1 C x1+14 y1, x2-14 y2, x2 y2`，起止点锚定源/目标节点盒边缘中线（几何断言 ≤1px）；无显式 edges 时从 dependencies 推导
- 聚焦高亮：默认派生选中不暗化；点选固定聚焦 → 上下游链 `data-focused` + 关联边 `data-active`，无关节点/边 `data-dimmed`（opacity 0.3 可见样式断言）；再点取消；Esc 解除；悬停 180ms 瞬态聚焦语义
- 滚动：画布=内容精确尺寸（40 节点链 4714px）；wrap `overflow-x:auto` 可实际滚动
- 布局：列=依赖深度（列距 118）、行=id 稳定排序（行距 38）

**④ 团队创建/绑定/切换流**（`teams-flow.spec.ts`，11 用例）
- 创建：编辑器打开、执行器下拉来自 snapshot、提交按钮文案随角色数变化、必填校验拦截不发请求、提交 payload（overwrite+config.team_id/roles）、新建关闭无确认
- 编辑：队员卡进编辑器、有改动时 Esc 丢弃确认门径（注：Esc 先关抽屉再触发丢弃确认，两次 Esc）
- 删除/设默认：确认弹窗门径，confirm 后分别发 `team/delete{teamId}` / `team/set-default{teamId}`（互斥确认）
- 会话绑定：下拉切团发 `session/set-binding{sessionId,teamId}`、切回未绑定发 `session/clear-binding`、有进行中任务锁定（locked 标注 + select 禁用）、选项含默认标注

## 3. 运行结果

| 门禁 | 结果 |
| --- | --- |
| `pnpm test:e2e:harness` | ✅ **54/54**（41.4s，workers=1 确定性） |
| `WEAVE_E2E_LIVE=1 pnpm test:e2e:live` | ✅ **10/10**（18.8s） |
| `pnpm test:e2e:live`（无 env，门控关闭） | ✅ 10 skipped（exit 0） |
| `pnpm exec eslint test/e2e/ playwright.config.ts` | ✅ 0 error 0 warning |

live 完整性判据：HTTP≥400 = 0；RPC 失败 = 0；页面未捕获异常 = 0。
RPC ok 统计：snapshot×39、provider/list×18、settings/describe×17、audit/list×15、knowledge/list×14、task/list×12、team/delete×8、knowledge/graph×8、session/revisions×6、team/import×3（全部 ok=true）。
截图 15 张：`.artifacts/weave-ui/test/e2e/live-*.png`；明细报告：`.artifacts/weave-ui/test/e2e/live-report.json`。

## 4. 缺陷与测试性发现

1. **[低] PromptDialog 按钮无 testid**：`session-revise-dialog` 的取消/提交反馈按钮仅有文案（会话面板其余动作均有 testid）。用例按弹窗动作区末位按钮结构定位，不阻塞；建议补 `${testId}-confirm/-cancel` 与 ConfirmDialog 对齐。
2. **[低] audit 过滤表单提交按钮无 testid**：「查询」按钮按 `page-audit form button[type=submit]` 结构定位；建议补 testid。
3. **[提示] 文档口径差异**：任务描述中的「贝塞尔边」在本次测试开始时（commit c4353fe 的 dist）尚未实现（直线 line + 箭头 marker）；测试期间开发侧并行落地了紧凑新实现（commit 工作树 + dist 21:52 重建）。**测试基准已对齐新实现**：92×30 节点、列距 118、行距 38、三次贝塞尔短柄、hover 180ms 瞬态聚焦、Esc 解除、无关节点暗化 opacity 0.3、画布内容尺寸 + 横向滚动。若 doc/05 §6.3 仍描述旧 fit 缩放实现，建议同步更新。
4. **[提示] live 会话面板条件跳过**：本次 live 运行时宿主未注入 conversation.view 页签（新会话无 Weave 团队页签），面板/DAG 探测按设计跳过并截图留证（live-12-no-panel-tab.png）；在已启用团队的会话中运行会执行完整断言。
5. **[提示] live 知识库只读**：approve 会单向改变真实知识状态（无对应 reject 恢复路径），live 层仅做只读验收；approve/reject 全覆盖在 harness 层完成。

## 5. 复现步骤

```bash
pnpm build                # harness 被测对象是 dist 构建产物，先构建
pnpm test:e2e:harness     # 确定性层，54 用例，CI 常驻
WEAVE_E2E_LIVE=1 pnpm test:e2e:live   # 真实层，需 127.0.0.1:3080 在线（bash 语法；cmd 用 set）
```
