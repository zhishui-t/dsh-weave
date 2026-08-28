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
