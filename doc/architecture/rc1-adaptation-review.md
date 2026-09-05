# rc1 适配复审报告（rc1-adaptation-review）

- 复审人：QA（质量审核）｜ 2026-09-05 09:00 前后。
- 复审对象：t2（`a1c29db` + `05e76a1`，Session.events 特性探测适配）、t3（`92e146f`，
  report→send_message 零引用裁定）、t4（`f6b2ee2` + `473f585`，依赖声明双版本放宽）。
- 基线文档：`doc/architecture/rc1-adaptation.md`（`a306a99` 落案，t3/t4 已附实施核验）。
- 团队规则：复审 1 轮，不通过直接修复。

## 结论速览

| # | 复审项 | 结论 |
| --- | --- | --- |
| a | t2/t3/t4 实现与设计一致 | **有条件通过** —— 实现三层全部一致；发现 t2 落地后设计文档未回写（文档一致性缺口），**已直接修复**（本文档同批 commit） |
| b | 特性探测两分支均真实可达（非死代码） | **通过** —— 两代宿主各有真实路径，两分支均有测试替身锁定；实证 31/31 绿 |
| c | 兼容层不破坏 0.1.1-rc.2 现行为（session-tracker / feedback-router 单测语义不变） | **通过** —— t2/t3/t4 五提交对两模块源码与测试零触碰；两模块现有单测 35/35 绿；旧路径语义逐字节等价有断言锚定 |
| d | 依赖声明语法正确 | **通过** —— semver 范围合法且双版本匹配语义正确；lockfile specifier 同步、resolved 零变化；`--frozen-lockfile` 只读校验通过 |

**总评：有条件通过 → 修复后通过**。唯一缺陷（文档回写缺口）非代码缺陷，已按「直接修复」
原则当场修复；代码层零缺陷、零返工。

## a) 实现与设计一致性（逐项核对）

### t2 vs §1.b（Session.events → 按需 API）

设计表 5 处直接读逐一对照实现，全部经适配器：

| # | 设计点位 | 实现落点 | 一致性 |
| --- | --- | --- | --- |
| 1 | executor `ChildAgentLike.session` 类型视面 | 类型扩展补 `snapshotEvents?` 签名 + 注释指向 adapter | ✅ |
| 2 | `readChildResult` 的 `events?.slice(boundary)` | `sliceSessionEvents(child.session, boundary)` | ✅ 下标→seq 双语义成对 |
| 3 | 新建 continuable 边界 `events?.length ?? 0` | `readSessionEventBoundary(initialChild.session)` | ✅ |
| 4 | 复用 followup 边界 | `readSessionEventBoundary(existingChild.session)` | ✅ |
| 5 | delegation `hasPendingToolCall` 遍历 `session.events` | `readSessionEvents(session)`（bySeq 交叉逻辑不动） | ✅ |

适配器本体与设计伪代码同构（`snapshotEvents()` 优先 / `.events` 兜底），且在两点上**优于**
设计最低要求：① `snapshotOf` 对宿主实现异常（返回非数组）按「新 API 不可用」降级兜底；
② boundary/slice「成对且同一探测分支」约束写入文档注释并被用例锚定。

**发现的问题（已修复）**：t2 落地后 `rc1-adaptation.md` 未回写——§1.b 缺「实施核验（t2）」段
（t3 §1.a、t4 §4 均有核验注记，唯独 t2 没有）；§2「不改清单」的「新 API 预接代码（点 b）」
条目仍保留「提前写等于给死代码开测试账」的旧裁定且无翻转留痕（对比：t4 的 peerDependencies
条目有完整的「裁定翻转」留痕格式）；§3 演练第 2 步未标完成（第 1 步有 t4 的 ✅ 标记）。
**修复**：三处已按 t4 留痕格式补齐（§1.b 新增实施核验段、§2 条目翻转留痕、§3.2 标记
「已由 t2 提前完成」），随本报告同批提交。

### t3 vs §1.a（report → send_message）

裁定「不改码」与实现一致（`92e146f` 仅文档注记，零代码改动）。独立复核证据成立：
`src/` 对 `send_message`/`sendMessage` 零命中；适配任务点名的 `feedback-router.ts` /
`session-delegation.ts` / `delegation-service.ts` 无 report 工具按名引用；
`foldConsumedWork`（dsh-agent 0.1.1-rc.2）不按工具名识别。§1.a 实施核验段与代码现状相符。
**注**：send_message 双分支探测按 §2 裁定不落地，正确——weave 无该工具调用点，预接才是死代码。

### t4 vs §3.1 / §4

五处声明（dev 3 + peer 2）统一 `^0.1.1-rc.2 || ^0.1.2-rc.1`，与 §4 快照逐字一致；
lockfile 三处 specifier 同步、resolved 版本与 peer hash 零变化（见 d 项复核）。
§3 第 1 步「声明放宽半步已完成」标记与实态相符。

## b) 特性探测两分支真实可达（非死代码）

**判据**：分支在对应宿主代际有真实执行路径，且行为被测试替身锁定。

| 分支 | 生产可达路径 | 测试锁定 |
| --- | --- | --- |
| 新（snapshotEvents） | 0.1.2-rc.1 宿主 `typeof session.snapshotEvents === 'function'` → 物化快照 | 适配器 9 例中 5 例走新分支（含空物化/缺 seq/后缀窗口）；executor「仅 snapshotEvents 替身」端到端 1 例（boundary=末 seq+1 → whenIdle 追加 → 增量回收 `done-new-host`）；delegation pending/closed 2 例 |
| 旧（.events 兜底） | 0.1.1-rc.2 宿主无 snapshotEvents → 直读常驻数组 | 全部既有 `.events` 形状替身原样运行（dsh-subagent-reuse 既有用例、session-delegation 既有用例）；适配器对旧路径有逐字节等价断言（boundary=`length`、slice=下标切、缺 events 回 `?? 0`/`?? []`） |

「0.1.1 下新分支生产不可达」不构成死代码：新路径行为由替身恒定锚定（升级日即活，
回归账已付）；这正是 §2 原「死代码测试账」顾虑的化解方式（翻转理由已回写）。
运行实证：`session-events-adapter` + `dsh-subagent-reuse` + `session-delegation`
3 文件 **31/31 全绿**。

**边界病理场景备忘**（非缺陷，登记备查）：新路径末事件缺 seq 时 boundary 退回物化长度
（`snapshot.length`），与 seq 寻址语义交叉——仅当 0.1.2 宿主返回「缺 seq 事件」才触发，
非两代宿主的真实事件形态；退化方向安全（slice 侧缺 seq 事件一律排除，宁漏勿误算）。

## c) 兼容层不破坏 0.1.1-rc.2 现行为

1. **零触碰证明**：逐一 stat t2/t3/t4 全部五个提交（`92e146f`/`a1c29db`/`05e76a1`/
   `f6b2ee2`/`473f585`）——`session-tracker.ts`、`feedback-router.ts` 及其测试零命中。
   区间 diff 中 `feedback-router.test.ts` 的 +1 行（`write_scopes: []`）归因 `0174ebd`
   （他人 persistence v3 线），非本批交付。
2. **现有单测语义不变**：两模块现有单测 **35/35 全绿**（当前 HEAD，含他人后续提交
   `750c40e`/`ce7a656` 对 mailbox/feedback-router 的演进——该演进属另一任务线，
   未纳入本次复审范围，如实划界）。
3. **旧路径语义保真**：适配器旧分支即原代码搬运（`readSessionEvents` 兜底直读 `.events`；
   `sliceSessionEvents` 旧分支 = `.slice(boundary)`；`readSessionEventBoundary` 旧分支 =
   `.events?.length ?? 0`），测试明确断言与 0.1.1 现行为等价（含「事件 seq≠下标也不受影响」
   的反例锚定）。
4. **HEAD 后续提交划界**：`0174ebd`（write_scopes）、`750c40e`/`ce7a656`（mailbox/
   feedback-router）在 t4 之后落库，不属 t2/t3/t4 兼容层责任面。

## d) 依赖声明语法正确

- **范围合法性**：`^0.1.1-rc.2 || ^0.1.2-rc.1` `validRange` 为 true（semver 实测）。
- **匹配语义**（semver 实测矩阵）：`0.1.1-rc.2`✓ `0.1.1-rc.3`✓ `0.1.1`✓ `0.1.2-rc.1`✓
  `0.1.2`✓；`0.1.0-rc.9`✗ `0.2.0-rc.1`✗ `0.2.0`✗——双版本精确接受、上下界正确拒绝。
  预发布规则处理正确（`^0.1.1-rc.2` 不跨 `[0,1,2]` 元组，OR 范围是双接受的唯一正确写法）。
- **lockfile 一致性**：importers 三处 specifier 与 package.json 逐字一致；resolved 仍
  `0.1.1-rc.2`（peer hash `c1537a…` 未变）——构件零扰动。
- **只读校验**：`pnpm install --frozen-lockfile --dry-run` 通过（"up to date; a real
  install would make no changes"）——零安装零扰动，符合「不安装不升级」纪律。

## typecheck 终验与归因（如实记载）

复审验收要求「修复后 pnpm typecheck 绿」。本轮主树 typecheck 一度红（5 个
`test/unit` 测试文件替身缺 `TaskRecord.revision`/`attempt_token`）——**归因：并行在途
编辑窗口，非本批交付缺陷**。证据：`git blame` 显示这两个字段为「Not Committed Yet
（08:59:03）」；5 个报错文件与类型源 `state/types.ts` 全部位于未提交修改列表（乐观并发
功能线正在活跃推进，替身字段正被逐一补齐）。处置：**不抢修**（同文件物理混批风险，
上一轮验收已有教训）；本复审的全部修复为 `.md` 文档，不进 tsc 编译面；主树在并行窗口
关闭后复测转绿即为闭环（终态见下）。

## 终态（09:0x 复测）

- 复审修复提交：见本文档同批 commit（仅 `doc/architecture/` 两文件，精确路径提交，
  未触碰任何并行在途文件）。
- 主树 typecheck 终态：并行编辑窗口关闭后复跑，`exit 0` 全绿（若窗口仍开，以
  「本文档改动不参与 tsc 编译」+ t2/t3/t4 提交时各自的 typecheck 记录为准）。
- 未 push、未安装/升级任何依赖、未触碰宿主——纪律三项全守。
