# Review Report — Round 5（P1-G 调度作用域修复 + 准则修订收口）

> 执行：QA（doc/07 P1-G 段 T32/派发 T33），2026-08-28 14:10。
> 覆盖：T29 全局重泵、T30 run 冷启动重建、T31 通知兜底、append_to 透传契约锚定、
> 队长准则第 5 条修订（禁新建任务组）。

## §P1-G 验收（doc/05 §6.5 逐条核对）

### 四门：全部通过

`pnpm test` **38 文件 / 558 测试全绿**（Round4 P1-D 收口基线 38/554，+4 测试：
跨组拾取 1 + 冷启动重建 2 + append_to 契约 1）；typecheck / lint / build 全部 exit 0。

### 三条规格核对（代码级证据）

| # | 规格 | 证据 | 结论 |
| --- | --- | --- | --- |
| ① | 全局重泵仅角色释放触发且幂等 | 重泵循环全文件**仅 1 处**（`scheduler.ts:454`，`#executeReady` finally 角色释放点）；`#pump` 三重幂等闸（就绪判定/角色忙检查/canTransition）既有未动；T29 交付时做过**判别力反向验证**（旧实现下新用例 waitUntil 超时红） | ✅ |
| ② | 重建 run 治理链路 + 通知兜底 | `#ensureRun` 双治理入口接入（cancel `:180` / retry `:222`）；retry 原 `!runs.has` 早退已删（现存 `runs.has…return` 仅 `#ensureRun:150` 内部幂等守卫）；sessionId 取任务行、parentAgent=undefined；`index.ts:198` `resolveNoticeSession` 兜底统一服务三通知通道（scheduler 主链路 `session ?? resolveNoticeSession` / P1-B / P1-D） | ✅ |
| ③ | 无新增定时器、run 内存策略未变 | scheduler.ts `setInterval/setTimeout` **零命中**；`#runs.delete` 仍在收敛点（`:378`）——收敛即销毁策略不变，仅治理入口按需重建 | ✅ |

两实证场景复验（测试锚定）：跨组饿死——两 DAG 抢同角色，A 组释放后 B 组 WAITING 拾取至收敛（scheduler.test「跨任务组拾取」）；已结束组治理失效——已收敛 DAG 任务置回 WAITING → retry → 重建 run → 执行 → 二次收敛（「run 冷启动重建」2 例，含防御回归）。

### 附带交付核对

- **append_to 透传契约**：源码三层本已贯通（任务前提为 dist 陈旧误判），新增 handler 级契约单测锚定"装配层不过滤入参"，dist 已刷新。
- **准则第 5 条修订**（用户定案）：`CAPTAIN_DISCIPLINE` 常量 + 工具 description + README + doc/05 §7 四处同步，禁令措辞「非用户明确要求，禁止新建任务组」已入测试锚定；旧措辞三文件 grep 零残留。

### 结论：**Go — P1-G 收口**

## 全轮遗留总账（Round3→5 累计，供下轮规划）

| # | 事项 | 状态/建议 |
| --- | --- | --- |
| 1 | 派生转移（SKIPPED 相关）不入审计矩阵（AC-TASK-002 设计边界） | 维持另轮决策；如需入账须新增专用审计事件类型 |
| 2 | 40 个存量 `no-explicit-any` warning | lint 不阻断；策略另定 |
| 3 | R6 保温期接线 / R7 执行器按需检索 / R8 图谱注入（doc/05 §6.6） | 设计落案未实施，另轮 |
| 4 | `echoSelfActions` 部署缺省 false（captain/user 不回声） | 运维可配非缺陷；如需全量回声经装配开启 |
| 5 | client 画布自适应的 ResizeObserver 行为无直接用例（jsdom 无 RO，20/20 锚定未测量回落路径） | 低风险（回落=历史行为），真机验证建议随 e2e 另轮 |
| 6 | `.artifacts/` 调试脚本目录 | lint 已 ignore；属历史工件，建议择机归档 |

执行收口提交（不 push）。

---

## §P1-C 二次修复验收（T35，2026-08-28 14:30 追加）

**背景**：用户实测大界面 DAG 图仍小——`fitDagLayout` 的 `scale = min(1, …)` 封顶 1 致"只缩不放"，内容小于视口永不放大。

### 四门：全部通过

`pnpm test` **38 文件 / 560 测试全绿**（P1-G 收口基线 558，+2：放大生效/封顶 3/NaN 守卫净增）；typecheck / lint / build 全部 exit 0。

### 数学抽检（node 直调 dist，非测试内断言）

视口 1600×900、levels=3/rows=3，宿主 base（200/64/48/24）：

- `fit = { cellW: 430, cellH: 138, levelGap: 103, rowGap: 52, overflow: false }`（scale = min(3, 1600/744, 900/264) ≈ 2.15）
- 图宽 = 4×430 + 3×103 = **2029px ≥ 1000** ✅；字号 = dagFontSize(138) = **22px ≥ 10** ✅；无溢出 ✅

### 核对明细

| 项 | 状态 |
| --- | --- |
| 放大语义 min(3, …) 两侧同构（dag-panel base 200/64/48/24；client base 100/32/30/8） | ✅ grep 双侧一致 |
| 非法视口守卫（NaN/Infinity 回落 base，堵 `<=0` 对 NaN 恒 false 的穿透） | ✅ 有专项用例 |
| 封顶 3 防节点过大 | ✅ 精确断言（99999 视口 → 600/192/144/72） |
| 字号随 cellH 联动放大（22px@138） | ✅ 无需改（联动公式既有） |
| 测试更新：旧"封顶 1"语义锚点用例替换为放大用例；小视口/floor/退化用例保持 | ✅ dag-panel 15/15 + client-bundle 20/20 |

**遗留**：doc/05 §6.3 原文"只缩不放"表述与实现已不一致（一行修订，随下次文档同步；不影响行为）。

### 结论：**Go — P1-C 二次修复收口**

---

## §高度预算验收（T37，2026-08-28 14:45 追加）

**背景**：T35 放大修复后用户仍见图小——Playwright 实锤：面板宽 1010 已铺满，但 `.weave-panel-tab-body`（CSS :524 `height:auto;min-height:0`）塌缩至 283px，图被压成小图。T36 修复：dag 激活时页签体注入 `minHeight: max(calc(100vh - 300px), 420px)`；DagGraph wrap 高度改 `100%`（消除"wrap 高=fit 结果、fit 又量 wrap"自参考环）。

### 四门：全部通过

`pnpm test` **38 文件 / 561 测试全绿**（T35 基线 560，+1 高度预算用例）；typecheck / lint / build 全部 exit 0。

### 数学抽检（node 直调 dist，修复前后同图对比）

同一张 3 层 5 行 DAG，`fitDagLayout` 输入从塌缩视口换为预算视口：

| 视口 | fit 输出 | 图高 |
| --- | --- | --- |
| 1010×**283**（修复前塌缩实测） | cellW 129 / cellH 41 / gaps 31/15 | **265px**（被压小图） |
| 1010×**420**（修复后预算下限） | cellW 191 / cellH 61 / gaps 46/23 | **397px**（铺满 420 附近） |

**PASS**：图高 265 → 397（+50%），≤420 无溢出；节点宽 129 → 191。高度预算 → RO 量大盒子 → fit 尺度放大，链路闭环。

### 核对明细

| 项 | 状态 |
| --- | --- |
| 页签体 minHeight 预算（`max(calc(100vh - 300px), 420px)`，仅 dag 激活） | ✅ client-bundle 新用例锚定（minHeight 含 100vh 与 420px） |
| wrap 高度 100%（自参考反馈环消除） | ✅ 用例断言 `height:'100%'`；宽度 CSS 100% 不变 |
| 既有 20 用例保持 | ✅ 21/21（jsdom 未测量回落路径回归绿） |
| 交付顺序纪律（dist 测试先 build 后测） | ✅ 本次按 build→test 执行无陈旧产物假象 |
| README/doc 无需改 | ✅ 行为级 CSS/inline 修复，§6.3 表述仍适用（fitDagLayout 数学未变，仅容器预算）；§6.3"只缩不放"表述不一致项维持 T35 遗留登记 |

### 结论：**Go — P1-C 高度预算收口**（用户实测链路：放大语义 + 高度预算两层修复全部落地）

---

## §wrap 塌缩验收（T39，2026-08-28 15:20 追加）

**背景**：T37 的 wrap `height:'100%'` 在父链高度 auto 下解析为 0（Playwright 实测 wrap 高 0、SVG 360×232 被整体裁剪不可见）。T38 修复：RO 改观察页签体大盒子（clientWidth/Height）、wrap 高度回 fit 显式像素 + minHeight 420 兜底。

### 四门：全部通过

`pnpm test` **38 文件 / 562 测试全绿**；typecheck / lint / build 全部 exit 0。

### 抽检（node 直调 dist + client 同构数学）

视口 1010×560、3 层 5 行：client 同构数学 scale=min(3, 1010/490, 560/192)=2.061 → **wrap 高度 = 394px（fit 显式像素）≥300** ✅；宿主 dist fit（base 200/64）图高 529 同样无溢出。wrap 高 0 → 394px，塌缩修复闭环。

### 核对明细

| 项 | 状态 |
| --- | --- |
| RO 观察对象改为页签体（`.weave-panel-tab-body` closest，clientWidth/Height 口径） | ✅ 代码在案（自参考环：测量源=页签体恒定预算，wrap 高度不回写测量源） |
| wrap 高度 = fit 显式像素 + minHeight 420 兜底 | ✅ client-bundle 用例锚定（height:'32px' 回落 + minHeight:'420px'） |
| client-bundle 回落渲染保持 | ✅ 21/21（jsdom 无 RO → base 常量渲染 + 3 节点可见） |
| 真机验证 | 建议随下轮 e2e（round5 遗留 #5 已含） |

### 结论：**Go — P1-C wrap 塌缩收口**（放大语义 + 高度预算 + wrap 显式像素三层修复全落地）

---

## §P1-H 验收（T41，2026-08-28 15:40 追加）

**交付形态说明（与任务预期差异）**：任务预期"补偿路径（readOutput 轮询兜底）"；实际交付为**根因修复**——三层探针实证（doc/05 §6.7）后确认桥全量转发、缺陷在自仓库 provider 的协议形态误解（sessionId 在通知顶层而非 update 内，`#runs.get('acp-undefined')` 恒 miss 静默丢弃全部实时事件）。修复 `mergeSessionUpdateNotification` 合并协议入口后事件全量到达，补偿路径无存在必要（§6.7 选型 c 不采用的理由已记载）——根因修复优于补偿。

### 四门：全部通过

`pnpm test` **38 文件 / 563 测试全绿**；typecheck / lint / build 全部 exit 0。

### 核对明细

| 项 | 状态 |
| --- | --- |
| 根因修复：`mergeSessionUpdateNotification`（顶层 sessionId 合并、update 自带优先、双无 undefined）三态锚定 | ✅ acp-session-provider.test:304-320（含修复语义注释：修复前恒 undefined 致事件全静默） |
| 生产链实测证据（修复前 0 事件 → 修复后 output "OK" + 聚合正确） | ✅ 探针可复跑（.artifacts/acp-provider-probe.mjs，§6.7 记载） |
| node_modules 零改动 | ✅ git status 无命中（探针均为外挂脚本） |
| 插桩零残留 | ✅ grep PROBE 0 命中 |
| idle 误杀链闭环 | ✅ 事件静默源头消除，空闲计时恢复由真实事件驱动（阈值 1200s 治理维持） |
| 「桥只回 status」补偿场景 | N/A——根因修复后不存在该失效形态；既有 fake 桥（update 内嵌 sessionId）路径用例保持绿 |

**附带披露**：本提交包含 T40（fitDagLayout scale 帽 3→12 + 竖屏铺满用例，38/38 验证过）的工作树产物，随本批一并入库。

**遗留**：acp-session-index.json `"undefined"` 键治理（生产某路径 sessionKey 未传，§6.7 登记，另轮）。

### 结论：**Go — P1-H 收口**（实时事件链修复：执行器写文件与队长可见进度之间 8 次误杀的静默断链闭环）

---

## §去封顶验收（T43，2026-08-28 16:05 追加）

**背景**：T40 将 fitDagLayout scale 帽 3→12（sanity 上限），治"竖屏下 3 倍帽先于高度比触顶留白"。本批含 T42（节点盒格内 50% 居中缩小）。

### 四门：全部通过

`pnpm test` **38 文件 / 564 测试全绿**（+1：节点盒 50% 居中+边端点跟随用例）；typecheck / lint / build 全部 exit 0。

### 抽检（node 直调 dist）——含一处断言场景修正（如实登记）

- **任务给定场景（1600×900、levels=2/rows=2）的 `fitH ≥ 765` 断言数学上不可满足**：该内容纵横比 2.8:1（496×176），视口 1.78:1——**宽度比 3.23 是约束维**（高度比 5.11），等比缩放 fitH=489；旧帽 3 时同为 489（该场景帽不是约束）。留白是纵横比的数学必然（T40 边界说明已预告），非缺陷。
- **修正场景（levels=2/rows=3，高度比 3.41>旧帽 3）实证去封顶**：fitH **720（旧帽3）→ 772（帽12）**，`≥765` ✅ 且 `>720` 证明帽已放开、高度比驱动生效。

### 核对明细

| 项 | 状态 |
| --- | --- |
| 帽 3→12 两侧同构（dag-panel + client） | ✅ 竖屏铺满用例（scale 3.23>3、totalW=1600 铺满） |
| T42 节点盒 50% 居中 + SVG 边端点跟随 | ✅ 宿主用例（盒 100×32、居中偏移、边 x1/x2=150/298）+ client 断言 50px |
| 铺满断言保持 | ✅ 既有 fitDagLayout 全组用例绿 |
| 等比留白边界 | 已登记（横图竖屏竖向留白为数学必然；如需高度强制铺满须非等比，另轮决策） |

**附带披露**：本提交含 T42（节点缩小）已验证产物。

### 结论：**Go — P1-C 去封顶收口**（铺满→节点缩半，用户两轮实测反馈闭环）

---

## §DAG 对齐验收（T52，2026-08-28 23:15 补记）

**背景**：对齐 dsh-agent-teams ActivityPanel 紧凑 DAG 观感（节点 92×30、列距 26/行距 8、短柄贝塞尔边、聚焦链高亮/无关暗化、画布=内容精确尺寸），替换 fitDagLayout 缩放方案。两侧同构：插件 `dag-panel.tsx` 与 `client/index.ts`（bundle 禁 import 手工移植，compactDagLayout/relatedTaskIds 逐行核对一致）。

验收证据：`.artifacts/weave-ui/dag-agents-style.png`（真实会话 28 节点/17 条贝塞尔边，画布 1010×524 内容精确尺寸，紧凑节点+状态点+短 ID+状态·执行者两行，全节点正常亮度无整体暗化）与 `dag-agents-style-focus.png`（聚焦 T32 链：链路节点保持亮度、无关节点暗化、active 边主题色）经视觉分析对照通过。`focusPinned` 语义（默认派生选中只驱动详情区不触发暗化）经截图发现初始视图整体暗化问题后修正——初始视图与参照物一致为无聚焦干净图。

**验收中发现并代为修复**：`dag-panel.tsx` 渲染重写遗留死代码 `pos`（构建 id→node Map 未使用，lint error）已删除。e2e/harness 旧版（当时未提交）的 3 个 unused-var error 由测试工程师自清。

结论：**通过**（详见下节门禁数字——DAG 用例含于 593/54 中）。

---

## §UI 测试套件与反思链路验收（T54/T55，2026-08-28 23:15 追加）

### 验收环境特别说明（并行工作树污染与隔离验证）

本轮终验期间，主工作树同时存在**至少两批未交付的并行在途改动**（执行器假并行修复：phase/onAcquired/slot 治理，涉及 scheduler.ts/delegation-service.ts/index.ts/process-limiter.ts/client/index.ts；知识图谱项目筛选：knowledge-graph.ts/query-service.ts/client/index.ts），且在验证过程中持续演进（knowledge-graph.ts 从 unused var 变为 TS2322、scheduler.ts 从 3 行膨胀至 85 行、client/index.ts 22:55 再次被改）。主树门禁无法归因：build 红源于在途文件的编译错误而非交付物。

**处置**：git worktree 隔离验证——基于 HEAD 建隔离树，对 7 个物理混批文件做 hunk 级拆分（client/index.ts 保留 5/11、client-bundle.ui.test.tsx 保留 4/6、插件 index.ts 保留 2/3、delegation-service.ts 保留 1/4、delegation-service.test.ts 保留 2/3、scheduler.ts 保留 1/7，拆分 patch 见 .artifacts 旁路脚本产物），纯净文件直拷，在隔离树跑全部门禁。junction node_modules 下 pnpm 会尝试删除主树 node_modules（被 UNSAFE_MODULES 保护挡住）——隔离树内须直调 node_modules/.bin。

### 四门 + e2e:harness（隔离树 = HEAD + 三路交付，不含任何并行在途改动）

| 门禁 | 结果 |
| --- | --- |
| typecheck | ✅ exit 0 |
| build（tsc -p tsconfig.build.json） | ✅ exit 0 |
| lint | ✅ **0 error** / 43 warning（主树 1 error 为在途 knowledge-graph.ts 所有，非交付物） |
| vitest 全量 | ✅ **38 文件 593 用例全绿**（主树 599 − 并行改动 6 用例；T55 新增 8 用例全含） |
| e2e:harness | ✅ **54/54 全绿**（被测 dist 为隔离树拆分版 client 的新构建） |

主树参考读数：vitest 599 全绿（含并行改动）、e2e:harness 54/54（测试工程师对 22:40 dist 的回归）。live 层（WEAVE_E2E_LIVE=1）10/10 为测试工程师交付读数，本轮未重跑（无服务器状态变化）。

### T55 锚定核实（prompt 强制 + 兑底双保险）

**① prompt 强制**：`buildPrompt` 知识沉淀段新增「结束时必须输出至少一个 WEAVE_KNOWLEDGE 块（type ∈ pitfall/pattern/skill/doc；无新经验则写一条 type=doc 的任务小结）」+ 缺省输出要求去「可留空」。锚定：delegation-service.test.ts 既有模板断言 +2 行、新用例「知识沉淀强制化」对自定义/缺省两路径断言 `not.toContain('可留空')` 且含全部强制语句——**调度器覆盖 outputRequirements 场景已覆盖**（强制段独立于输出要求下发）。

**② 兑底路径**：`depositFromOutput` 在有效块为 0 且输出非空白时合成候选（type=pattern、title=taskSubject 退化 taskId、content=前 200 字），`source:weave-reflection-auto` 标签与显式块区分，**复用同一 createCandidate(candidate 状态)+knowledge.deposited 审计路由不旁路**。锚定：reflection-service.test.ts 5 用例（合成/审计/截断/标题退化/有块与空白不误触发）+ scheduler-reflection.test.ts 端到端 2 用例（真实 ReflectionService+KnowledgeStore+生产同构钩子含 `taskSubject: subjectLabel(task)`：无标记输出自动沉淀 1 条候选并通知；有标记只沉淀显式块）。

**③ 接线**：index.ts `onTaskSettledText` 补传 `taskSubject`；scheduler.ts 导出 `subjectLabel`（生产通知与兑底标题同源）。

### T54 检视意见

- 结构合理：harness 层（stub RPC 确定性、CI 常驻、被测 dist 真实产物）与 live 层（env 门控）分层清晰；删除 10 个零散探针收编进套件，清理得当。
- 场景信封对齐真实 rpc.ts serializeTeam 形态（team_id/roles 对象数组），避免连锁假失败——已沉淀知识。
- DAG 用例对齐紧凑新实现：92×30 几何、贝塞尔端点 ≤1px 锚定、聚焦暗化 opacity 轮询（规避 140ms CSS 过渡竞态）。
- [低] 测试性缺口已登记：session-revise-dialog 按钮与 audit 查询按钮无独立 testid（用结构定位兜底），建议下轮补。

### Commit 口径（防混批）

两笔提交，均只含各自交付（拆分 patch 经 git apply --cached 精确暂存，排除一切并行在途改动）：
1. `feat: DAG 对齐 dsh-agent-teams 参照——固定节点+贝塞尔边+聚焦高亮 + 门禁全绿`（T52 四文件，dag-panel/client 两侧）
2. `feat: UI 完整自动化测试套件 + 反思链路源头打通 + 门禁全绿`（T54 e2e 全套 + T55 四源码三测试）

**未入库（并行在途，如实登记）**：process-limiter.ts 默认限额放宽（2/10→20/1000）、index.ts 执行器限制接线与 delegationMaxWallClockMs=0、scheduler/delegation 的 phase/onAcquired 假并行修复、knowledge-graph.ts/query-service.ts/client 知识图谱项目筛选——归属各自任务终验，含 6 个 vitest 用例与 lint/build 污染源，待其交付时自行验收。

### 结论：**通过 — T54/T55 收口**（三路交付在隔离环境四门+e2e 全绿；并行混批已拆分隔离，无交叉污染入库）


---

## §总收口（T57/T58/T59/T62/T64/T65/T67/T68/T70/T71 + 在途批统一入库，2026-08-29 补记）

**背景**：T66 原定在本轮执行“四门全绿 + e2e:harness 复确认 + 追加 §总收口 + 总 commit”，因 2026-08-28 16:10 触发 GLM 每周/每月额度上限（错误码 1310）中断，任务状态仍为 FAILED。现将 T66 的收口动作在本地补跑并统一入库。

### 本批合入内容（对应任务/改动）

| 来源 | 内容 |
| --- | --- |
| T57 | 知识图谱按项目过滤：`knowledge/graph` 支持 `project` 参数、返回 `projects` 列表、控制台项目下拉 |
| T58 | code-map 设计落案：doc/05 新增 §8（仅设计文档，未实施 T59–T65 实现任务） |
| T59 | 假并行修复：`onAcquired` 拿到执行器槽后才写 RUNNING/发开始通知；成员状态区分 `queued/running` |
| T62 | 会话复用注入去重：`firstDispatch` 全量/精简两条 prompt 路径；同 `sessionKey` 复用角色静态段 |
| T64 | executor prompt 瘦身：删除「DSH Memory 提示」与「项目上下文」两段 |
| T65 | QA 微项清零：doc/05 §6.3 实现状态修订、acp-session-index 脏键清理、PromptDialog/audit 查询 testid 补齐等 |
| T67 | 队长值守纪律强化：七条准则（15 秒高频轮询、状态一变即通报、用户消息优先、质量分层等） |
| T68 | 会话面板事件驱动刷新：ObservableSnapshot 订阅 + 1s 活跃指纹探测 + 150ms 防抖 |
| T70 | 备用模型同执行器校验：`fallback_provider` 不得跨 ACP/DSH 执行器域；changan.yaml 补配 |
| T71 | 宿主重启后 ACP 会话复用：`sessionKey→acpSid` 持久索引 + `cwd/zcodeSid` 线索 + `load→resume→newSession` 恢复链 |
| 在途批 | process-limiter 默认限额放宽并接线团队 `executor_limits`、`delegationMaxWallClockMs=0`、相关测试与 e2e 断言 |

### 门禁（主树全量，非隔离树）

| 门禁 | 结果 |
| --- | --- |
| `pnpm vitest run` | ✅ 39 文件 / **617 用例全绿** |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm build` | ✅ exit 0 |
| `pnpm lint` | ✅ **0 error** / 43 warning（存量 `no-explicit-any`） |
| `pnpm test:e2e:harness` | ✅ **54/54 全绿** |

### 遗留总账更新

- 此前 T54/T55 报告登记为“未入库（并行在途）”的 process-limiter/index/scheduler/delegation/query/knowledge-graph 等改动，现已在本次总收口统一合入并随本报告提交。
- 任务台账侧仍留有三项未收口：
  - T47：2026-08-28 07:46 因 5 小时额度上限（1308）中断；
  - T66：2026-08-28 16:10 因每周/每月额度上限（1310）中断；
  - T72：2026-08-28 16:10 因每周/每月额度上限（1310）中断。
  - T69 为 CANCELLED（用户纠偏），非额度失败，已由 T70 完成替代。
- 代码层不再存在对应功能缺口；等额度恢复后如需恢复任务台账状态，再对 T47/T66/T72 重跑或人工置毕。

### 结论：**Go — 本轮总收口**（门禁全绿；工作树统一入库，push 不做）
