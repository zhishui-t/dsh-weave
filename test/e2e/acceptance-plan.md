# Weave Web 控制台 Playwright E2E 验收方案（t5 预研）

> 作者：weave-qa-e2e ｜ 状态：t4 联调期间的只读预研产物，t5 启动时按此落地。
> 本文只新增，不修改任何源码；t5 前不动 `src/client`、`src/plugins/weave/rpc.ts`、`web/query-service.ts`。

## 1. 已核实现状（2026-07-24 @ 088f9dd）

- **入口链路**：client bundle 注册 `sidebar.footer.action`（label "Weave"）→ 按钮 `weave-open` 打开全屏 portal `weave-dashboard` → 左侧导航 `nav-<key>` 切换 8 页 → `weave-close` 关闭卸载。
- **路由表**：overview 总览 / teams 团队 / tasks 任务中心 / knowledge 知识库 / executors 执行器 / sessions 会话管理 / audit 审计日志 / settings 设置（`ROUTES`，src/client/index.ts:60）。
- **传输层**：唯一入口 `connection.rpc.call('/dsh-weave', endpoint, payload)`；成功 `{ok:true,value}`，失败 `{ok:false,error:{code,message,details}}`；客户端把失败抛成 ``Error(`${code}: ${message}`)`` → 页面渲染 `page-error`。宿主侧 `connection.rpc.handle(WEAVE_RPC_CHANNEL, …, {authority:'trusted-host'})`。
- **客户端消费的 RPC endpoint**：`snapshot`、`team/import`、`team/delete`、`team/list`、`task/list`、`task/action{action,taskId}`、`task/get{taskId}`、`task/create`、`knowledge/list`、`knowledge/approve{id}`、`knowledge/reject{id,reason}`、`session/bindings`、`session/revisions{limit}`、`session/set-binding{sessionId,teamId}`、`session/clear-binding{sessionId}`、`audit/list`、`settings/describe`。
- **环境**：react/react-dom **18.3.1**（UMD 构建可用）、@testing-library/react 16、vitest；**未安装 @playwright/test**（t5 需新增 devDep + `npx playwright install chromium`）。
- **已有 jsdom 层 UI 测试**：`src/plugins/weave/__tests__/client-bundle.ui.test.tsx` 直接执行 `dist/client/index.js` 并用 ModuleLoader 桩捕获 bundle —— Playwright 是其上的真实浏览器层，被测对象同为 dist 构建产物。

### 关键 testid 清单（grep 自 src/client/index.ts）

- 壳：`weave-overlay` / `weave-dashboard` / `weave-nav` / `nav-<key>`(含 data-active) / `weave-close` / `weave-open`
- 通用态：`page-error`(kind=error) / `page-note` / `page-empty` / `pager`
- teams：`team-id-input` `team-name-input` `role-editor-<i>` `model-select`(i>0 为 `model-select-<i>`) `team-add-role` `team-create-submit` `team-delete-<id>`
- tasks：`task-search` `task-status-filter` `task-row-<id>` `task-detail-toggle-<id>` `task-action-<action>-<id>` `task-project-input` `task-version-input` `task-create-submit` `task-detail`
- knowledge：`knowledge-status-filter` `knowledge-layer-filter` `knowledge-item-<id>` `knowledge-approve-<id>` `knowledge-reject-<id>` `knowledge-reason-<id>` `knowledge-reject-confirm-<id>`
- executors：`zcode-catalog`
- sessions：`binding-session-input` `binding-team-input` `binding-set` `binding-row-<sid>` `binding-unbind-<sid>` `revision-row-<tid>`
- audit：`audit-type-filter` `audit-from` `audit-to` `audit-order` `audit-event-<index>`
- settings：`settings-list`

## 2. Playwright 用例骨架方案

### 目录规划（t5 时全部为新增文件）

```
test/e2e/
  harness/host.js               # __ModuleLoader__ 桩 + moduleRequire(react/react-dom→window.UMD) + connection 桩
  fixtures/rpc-mock.ts          # 场景化 mock：endpoint→envelope 注册表（window.__WEAVE_RPC__）
  fixtures/seed.ts              # 八页共用假数据工厂（团队/任务 DAG/知识候选/绑定/审计事件）
  specs/shell.spec.ts           # 开关 + 导航 + 标题
  specs/{overview,teams,tasks,knowledge,executors,sessions,audit,settings}.spec.ts
  specs/error-paths.spec.ts     # RPC 失败信封 → page-error
  specs/gallery.spec.ts         # 八页定妆照输出
playwright.config.ts            # testDir:'e2e'，无需 webServer
```

### harness 关键决策

1. **不起 DSH 后端**（默认模式）：`page.route('https://weave.test/**')` fulfill 三类脚本——react/react-dom UMD（node_modules 直读）、harness host.js、`dist/client/index.js` 文本。
2. host.js：定义 `window.__ModuleLoader__={load}` 捕获 bundle factory → 以 `moduleRequire = id => ({react:window.React,'react-dom':window.ReactDOM})` 调 factory → 伪造 ctx `{get:()=>'connection', slots:{inject,register}, effect}`；`connection.rpc.call = (channel, endpoint, payload) => Promise.resolve(window.__WEAVE_RPC__[endpoint](payload))`（未注册 endpoint 一律 fail loudly，防漏测）。
3. **双模式**：mock 模式默认（确定性、离线、截图稳定）；live 冒烟 spec 仅当 env `WEAVE_E2E_BASE_URL` 存在才跑（`describe.skipIf`），打真实控制台只断言壳+八页可达，不写数据。
4. **命令**：`"test:e2e": "pnpm build && playwright test"` —— 与 jsdom 测试同口径，被测对象是构建产物而非源码。

## 3. 截图目录方案

| 用途 | 路径 | 入库策略 |
| --- | --- | --- |
| 失败诊断件（trace/video/failure screenshot） | `test-results/`（playwright 默认） | gitignore，不入库 |
| 八页定妆照（人工验收比对） | `test/e2e/artifacts/gallery/<page>.png`（1280×900） | gallery.spec 每次运行覆盖输出 |
| 像素 diff 基线（暂不启用） | `test/e2e/__screenshots__/`（playwright 默认） | t3 后界面仍会迭代，先不开 toHaveScreenshot；启用时单独 commit |

## 4. 八页验收断言清单

### 全局壳（shell.spec）
1. `weave-open` 可见且位于侧栏动作区；点击后 `weave-dashboard` 出现，标题为 `Weave 控制台 · <页名>`。
2. `nav-*` 共 8 项；逐项点击后对应 `page-<key>` 可见且 `data-active=true`，其余页面隐藏。
3. `weave-close` 点击后 dashboard 卸载（`weave-dashboard` 消失）。

### ① 总览 overview
六卡数字与 mock 对账：团队/执行器数 ← snapshot；任务总数 ← task/list；BANNED 数 ← `task/list{status:'BANNED'}` total；待审知识 ← knowledge/list candidate；最近审计 ≤5 条 ← audit/list。六卡可点击并跳转对应页。

### ② 团队 teams
列表渲染已有团队；`team-delete-<id>` 先弹 confirm 再调 team/delete；创建器 id/name 必填；`role-editor-<i>` 可增删角色；点 `team-add-role` 后提交按钮文案变「创建团队（包含 N 个角色）」；执行器下拉选项 = snapshot 返回什么显示什么；仅 executor=zcode 时显示 model-select(-N)/思考深度/模式；提交调 team/import 且新团队出现在列表。

### ③ 任务中心 tasks
`task-search` 触发带 search 的 task/list；`task-status-filter` 14 态可选且过滤生效；分页 pager page/pageSize=20、总数正确、翻页重新请求；`task-detail-toggle-<id>` 展开 `task-detail` 显示 DAG 节点/边（task/get）；**动作矩阵严格等于 TASK_ACTIONS_BY_STATUS**（WAITING/BLOCKED=[cancel(confirm),skip]；RUNNING/REVISION_RUNNING=[cancel(confirm)]；AWAITING_FEEDBACK=[revise,accept,skip]；FAILED=[retry,skip]；BANNED/LOOP_TERMINATED=[retry]；INTERRUPTED=[retry,cancel(confirm)]；CLOSED/CANCELLED/SKIPPED=[reopen]；COOLDOWN/COMPLETED=[]）；confirm 类动作必须二次确认才发 task/action；创建表单 project/version → task/create 后列表刷新。

### ④ 知识库 knowledge
status 过滤 4 态（candidate/active/deprecated/superseded）、layer 过滤 4 层（project/role/instance/shared）；approve 单击即发 knowledge/approve{id}；reject 两步流：reject → `knowledge-reason-<id>` 必填 → `knowledge-reject-confirm-<id>` 发 knowledge/reject{id,reason}；空理由被拦（前端禁用或 invalid_argument 错误可见）。

### ⑤ 执行器 executors
执行器列表来自 snapshot 真实注册项；`zcode-catalog` 面板渲染模型/能力目录。

### ⑥ 会话管理 sessions
`binding-set` 提交 session/set-binding{sessionId,teamId}；`binding-row-<sid>` 列出 bindings；`binding-unbind-<sid>` 调 clear-binding 且行消失或状态更新；`revision-row-<tid>` 来自 session/revisions(limit 20)。

### ⑦ 审计日志 audit
`audit-type-filter` 类型过滤（task.status_changed 等）；`audit-from`/`audit-to` 时间区间；`audit-order` 排序方向切换重新请求；`audit-event-<index>` 渲染事件字段；无数据显示 `page-empty`。

### ⑧ 设置 settings
`settings-list` 渲染 settings/describe 返回的配置键值。

### 横切（error-paths.spec）
任一 endpoint 返回失败信封 → 该页出现 `page-error` 且文案含 `${code}: ${message}`；加载中态 `page-note`；空数据 `page-empty`。

## 5. t5 启动前置条件（等 t4 completed 后执行）

1. 新增 devDependencies：`@playwright/test`；首次运行前 `npx playwright install chromium`。
2. package.json 增加 script `test:e2e`；`.gitignore` 增加 `test-results/`、`test/e2e/artifacts/`。
3. 全部用例走 fixture mock 数据，不污染真实持久化状态；不修改 `src/client`、`rpc.ts`、`query-service.ts`。

## 6. 落地记录（t5 交付 @ 8e91d67）

最终实现与预研方案的差异与结论：

- **双层结构**：`test/e2e/harness/`（虚拟域 + ModuleLoader 桩 + `__WEAVE_RPC__` 信封注册表 stub，确定性验证 UI 逻辑）与 `test/e2e/live/`（真实 http://127.0.0.1:3080 真实 Connection RPC，无 mock）。两层均默认执行：`pnpm test:e2e:harness` / `pnpm test:e2e:live` / 合并 `pnpm test:e2e`。
- **live 层为主验收**（队长要求），harness 层为稳定回归层；本机 Chromium 经 executablePath 指定，依赖固定 @playwright/test 1.62.1。
- 截图/trace 落 `.artifacts/weave-ui/`（已 gitignore）；汇总报告 `.artifacts/weave-ui/live-report.json`。

### 实测踩坑（对方案的关键修正）

1. **GBK 编码嗅探**：fulfill 的 HTML 未声明 charset 时，Chromium 在中文环境下嗅探为 GBK，外链 JS 继承文档编码——UTF-8 中文尾字节吞掉闭合引号导致 "missing ) after argument list"。修复=meta charset + 所有 contentType 显式 `; charset=utf-8`。
2. **原生 confirm() 门径**：知识驳回与团队删除走 `window.confirm`，headless 默认 dismiss 会静默取消操作 → 用例内 `page.on('dialog', d => d.accept())`。
3. **task/create 团队选择语义**：显式 team_id > 会话绑定 > 默认 > 唯一；团队数 ≥2 时"唯一"分支失效报 invalid_team → 用例显式填入刚创建的团队 ID，并在收尾用例删除自建团队保持状态自净。
4. **team/import 阶段校验（HI-4）**：角色 stages 必须覆盖项目阶段（默认 prepare,implement,review），否则 "阶段未绑定任何角色"。

### 最终门禁结果

| 门禁 | 结果 |
| --- | --- |
| pnpm typecheck | ✅ |
| pnpm lint | ✅ 0 errors（36 存量 warnings 位于旧 src） |
| pnpm test | ✅ 397/397 |
| pnpm build | ✅ dist/client/index.js 70153B 与线上一致 |
| e2e harness | ✅ 5/5 |
| e2e live | ✅ 9/9 ×2 连跑稳定（含创建→删除自平衡） |

Live RPC 终态统计（全部 ok=true）：snapshot×31、task/list×12、knowledge/list×8、audit/list×9、session/bindings×8、session/revisions×8、settings/describe×8、team/import×3、task/create×4、task/get×4、team/delete×7；HTTP≥400 = 0；页面未捕获异常 = 0。
