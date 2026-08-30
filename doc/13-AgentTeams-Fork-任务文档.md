# 13. AgentTeams Fork 任务文档

> 配套：`doc/11-agent-teams-fork-迁移决策.md`、`doc/12-AgentTeams-Fork-详细设计.md`
> 状态：v1 任务拆解（未开始执行）
> 主线环境：DSH `0.1.1-rc.2`，Node `v24.15.0`

## 0. 执行状态（2026-08-30 更新）

| 任务 | 状态 |
|---|---|
| T1 fork 基线 | ✅ 完成，fork verify 全绿 |
| T2 executor 字段 | ✅ 完成 |
| T3 MemberTransport | ✅ 完成 |
| T4 bootstrapTeam + hooks | ✅ 完成 |
| T5 yaml→profile 映射 | ✅ 完成 |
| T6 会话启动建队 | ✅ 完成（headless/web 均可动态注册 profile） |
| T7 知识桥 | ✅ 单元完成；运行时 enrichAssignment 已接线 |
| T8 反思桥 | ✅ 完成；真实任务已产生 knowledge.deposited |
| T9 ACP 索引 v2 | ✅ 完成 |
| T10 AcpMemberTransport | ✅ 完成并已注册；真实 ACP 派单启动 |
| T11 spawn/fork 集成 | ✅ 全链路通过（建队→派单→完成→删除） |
| T12 acp 集成 | ⏳ 部分：ACP 建队/派单/working 通过，执行完成未在超时内确认 |
| T13 退役旧模块 | ⏸ 未开始，需 T12 确认后执行 |
| T14 文档/发布 | ⏸ 未开始 |
| T15 alpha 预研 | ⏸ 延后 |

真实验证环境：
- `web-fork` profile 可启动
- `headless-fork` profile 可跑模型会话
- 主 `web` profile 尚未重启载入新代码


- 小步快跑：每个任务独立验证，验证通过再进下一个。
- 不跨任务同时改核心：fork 侧和 weave 侧分批完成。
- 任何任务失败立即停止，定位根因后再继续，不带坏状态往下走。
- 默认在 `master` 上做；每个任务完成时以测试/构建作为提交门禁。

## 1. 任务总览

| 任务 | 内容 | 优先级 | 依赖 | 验证门禁 |
|---|---|---|---|---|
| T1 | 建立 fork 仓库与基线 | P0 | — | fork 在 rc.2 环境 `verify` 通过 |
| T2 | fork 增加 `executor` 字段（类型 + profile） | P0 | T1 | fork typecheck + 单测 |
| T3 | fork 抽取 `MemberTransport`，spawn/fork 走 Dsh transport | P0 | T2 | fork 原测试全绿 |
| T4 | fork 增加 `bootstrapTeam` + `enrichAssignment` + `onTaskSettled` | P0 | T3 | fork 单测 |
| T5 | weave `teamConfigToProfile` 纯函数映射 | P0 | T2 | weave 单测 + typecheck |
| T6 | weave 会话启用建队 `SessionBootstrap` | P0 | T4,T5 | 冒烟：启用团队→建队 |
| T7 | weave 知识桥 `KnowledgeBridge` | P1 | T6 | 单测 + 建队注入冒烟 |
| T8 | weave 反思桥 `ReflectionBridge` | P1 | T4 | 单测：终态→deposit |
| T9 | weave ACP 索引 v2 `ExecutorSessionStore` | P1 | — | 单测：读写/兼容/隔离 |
| T10 | weave `AcpMemberTransport` | P0 | T3,T9 | mock 测试 + 真 zcode 冒烟 |
| T11 | 集成验证：spawn/fork 团队跑通最小 DAG | P0 | T4,T5,T6,T7,T8 | e2e |
| T12 | 集成验证：acp 团队跑通最小 DAG（含重启复用） | P0 | T10,T11 | e2e |
| T13 | 退役旧任务/团队模块 | P1 | T12 | 全量测试 + typecheck + build |
| T14 | 文档与发布配置更新 | P1 | T13 | README/doc 与 profile 冒烟 |
| T15 | alpha 预研线（可选延后） | P2 | T13 | web-alpha profile 验证 |

## 2. 任务明细

### T1 建立 fork 仓库与基线

**目标**：把 `dsh-agent-teams v0.1.14` 变成可维护的 fork。

**步骤**：
1. 在目标 GitHub 组织创建 `dsh-agent-teams` fork（组织/仓库名待用户确认）。
2. 本地加 remote，拉 `main`。
3. 在 **当前 rc.2 环境** 安装依赖并跑官方验证。

**交付物**：
- fork 仓库 + 本地 clone
- rc.2 环境下的验证记录

**验收**：
- `pnpm install` 成功
- `pnpm verify` 通过（或列出与 rc.2 的已知偏差）
- `pnpm typecheck` 通过

**验证命令**：
```bash
cd /k/work/GitHub/dsh-agent-teams
pnpm install
pnpm verify
```

### T2 fork 增加 `executor` 字段

**目标**：让 profile 成员和 TeamMember 携带执行器类型。

**步骤**：
1. `src/types.ts`：`TeamMember.executor?: string`
2. `src/profiles.ts`：`TeamProfileMemberConfig.executor?: string`
3. `MEMBER_KEYS` 增加 `executor`
4. normalize：trim + 非空校验
5. profile 建队时把 `executor` 写入 `TeamMember`

**验收**：
- profile 带/不带 executor 均通过 normalize
- 非法 executor 报明确错误
- 建队后 team.json 中成员 executor 正确

**验证命令**：
```bash
pnpm typecheck
pnpm vitest run src/  # fork 现有测试
```

### T3 抽取 MemberTransport（spawn/fork 原路径）

**目标**：把成员执行与调度解耦，但行为完全不变。

**步骤**：
1. 新建 `src/member-transport.ts`、`src/member-transport-registry.ts`
2. 新建 `src/member-transport-dsh.ts`，搬入现有 `spawnMember / deliverToMember / interruptMember / isMemberAvailable`
3. `src/scheduler.ts` 改为通过 registry 调 transport
4. 默认 transport 解析：`member.executor ?? memberProvider`
5. 原 `members.ts` 保留纯函数，执行函数迁入 transport 文件

**验收**：
- fork 全部原测试通过（重点：scheduler/members）
- 新增 registry 单测：解析规则/未注册报错
- spawn/fork 团队冒烟行为不变

**验证命令**：
```bash
pnpm typecheck
pnpm vitest run
```

### T4 fork 增加建队与钩子

**目标**：提供程序化建队、派单 prompt 增强、任务终态钩子。

**步骤**：
1. 抽出 `bootstrapTeam`（复用 `initializeProfileTeam` 路径）
2. 定义 `AgentTeamsHostHooks` service
3. scheduler 派单前调用 `enrichAssignment`（失败降级原 prompt）
4. tools 终态提交后调用 `onTaskSettled`（失败只 warn）
5. `index.ts` 安装 service 并导出类型

**验收**：
- `bootstrapTeam`：已有 team 复用；无 team 新建；锁内并发安全
- enrich 钩子返回值实际进入成员 prompt
- task completed/failed 触发 onTaskSettled，钩子抛错不阻断状态提交

**验证命令**：
```bash
pnpm typecheck
pnpm vitest run
```

### T5 weave yaml→profile 纯函数映射

**目标**：把我们的 yaml 团队配置转成 fork profile。

**步骤**：
1. 新建 `src/plugins/weave/team-profile-mapper.ts`
2. 实现 `teamConfigToProfile(team, sessionId)`
3. 字段映射严格按 `doc/12` §5.1
4. 补充 `stages/strengths/bias` → protocol 文本
5. 单测覆盖每个 yaml 字段和边界（空值、缺省、fallback 成对）

**验收**：
- 纯函数无 I/O
- 所有现有 changan yaml 配置能生成合法 profile
- 快照测试稳定

**验证命令**：
```bash
pnpm vitest run src/plugins/weave/__tests__/team-profile-mapper.test.ts
pnpm typecheck
```

### T6 weave 会话启用建队

**目标**：用户启用团队时按 yaml 配置调用 fork 建队。

**步骤**：
1. 新建 `src/plugins/weave/session-bootstrap.ts`
2. 接入现有 pre-step 启用团队流程
3. 生成 `teamId = sanitizeKey(yamlTeamId + '-' + shortSessionId)`
4. 先 `findTeamByCaptain` 复用，再 `bootstrapTeam`
5. 持久化 session ↔ yaml team_id ↔ teamId 绑定
6. 建队失败回滚绑定并 notice

**验收**：
- 首次启用 → 创建小队
- 同会话再次启用 → 复用不重复建队
- 两个会话同团队配置 → 两个 teamId 互不冲突
- 失败时无脏绑定

**验证命令**：
```bash
pnpm vitest run src/plugins/weave/__tests__/session-bootstrap.test.ts
pnpm typecheck
```

### T7 weave 知识桥

**目标**：建队和派单时注入我们的知识库。

**步骤**：
1. 新建 `src/plugins/weave/knowledge-bridge.ts`
2. 建队后按 role 检索并追加 executionPrompt / protocol
3. 派单前通过 `enrichAssignment` 追加 ticket 相关知识
4. 检索失败降级为空，不阻断
5. 成员工具白名单放行 `weave_knowledge_search`（fork 侧补 toolFilter 配置）

**验收**：
- 命中知识进入成员 prompt
- 无命中/引擎异常不影响派单
- 成员可调用知识搜索工具

**验证命令**：
```bash
pnpm vitest run src/plugins/weave/__tests__/knowledge-bridge.test.ts
pnpm typecheck
```

### T8 weave 反思桥

**目标**：fork 任务终态接入我们的反思沉淀。

**步骤**：
1. 新建 `src/plugins/weave/reflection-bridge.ts`
2. 注册 `onTaskSettled`
3. 映射 `TeamTask → ReflectionDepositInput`
4. 调用 `ReflectionService.depositFromOutput`
5. 失败只 warn，不阻断 fork

**验收**：
- completed/failed 触发 deposit
- projectId=yamlTeamId，version=teamId
- 反思异常不影响任务状态

**验证命令**：
```bash
pnpm vitest run src/plugins/weave/__tests__/reflection-bridge.test.ts
pnpm typecheck
```

### T9 weave ACP 索引 v2

**目标**：实现 `ExecutorSessionStore` v2。

**步骤**：
1. 新建 `src/plugins/weave/executor-session-store.ts`
2. 路径 `~/.dsh/weave/acp-session-index.json`
3. schema v2：`type / acpSid / updatedAt`，不存 cwd
4. 兼容旧记录
5. `sessionKeyOf` 使用 workspace fingerprint + teamId + roleId

**验收**：
- 同 key 恢复 acpSid
- 不同 workspace/team/role 不串
- 旧记录只读兼容
- 文件损坏按空索引处理

**验证命令**：
```bash
pnpm vitest run src/plugins/weave/__tests__/executor-session-store.test.ts
pnpm typecheck
```

### T10 weave AcpMemberTransport

**目标**：把 ACP 包装成 fork 的 MemberTransport。

**步骤**：
1. 新建 `src/plugins/weave/acp-member-transport.ts`
2. 实现 provision/isAvailable/deliver/interrupt/dispose
3. `deliver` 走 `AcpSessionProvider.start({ sessionKey, resumeSessionId })`
4. result 完成后 `onSettled` + idle 回写
5. 主机侧状态回写由 fork 的 `onSettled` 适配器完成
6. mock 测试 + 真 zcode 冒烟

**验收**：
- mock：working → settled → idle 状态正确
- 失败/abort 保留 partial output
- 真 zcode：同 sessionKey 复用会话
- 中断不泄漏 run

**验证命令**：
```bash
pnpm vitest run src/plugins/weave/__tests__/acp-member-transport.test.ts
pnpm typecheck
# 真 zcode 冒烟（按现有 e2e:harness 环境）
pnpm test:e2e:harness
```

### T11 集成验证：spawn/fork 团队

**目标**：证明 fork 内核 + 我们的配置/知识/反思桥跑通。

**场景**：
- 启用 yaml 团队 → 自动建队
- 队长拆 3 个有依赖任务
- spawn 角色跑通
- fork 角色跑通
- 任务完成后反思沉淀出现
- 知识注入出现在成员 prompt/工具面

**验收**：
- 三条任务全 completed
- 知识候选按预期生成
- 会话面板显示小队

**验证命令**：
```bash
pnpm build
pnpm test
pnpm test:e2e:harness
```

### T12 集成验证：acp 团队 + 重启复用

**场景**：
- 团队中至少一个角色 `executor: acp`
- 最小 DAG 跑通
- 重启 weave/DSH 后同会话同角色继续复用 ACP 会话
- 不同会话同团队配置不串会话

**验收**：
- ACP 任务 completed
- 重启后 `resumeSessionId` 命中旧 acpSid
- 两个会话的 ACP 上下文互不污染

**验证命令**：
```bash
pnpm test:e2e:harness
```

### T13 退役旧任务/团队模块

**目标**：删除/冻结自研任务核心，只保留边界能力。

**步骤**：
1. 确认 T11/T12 全绿后执行
2. 删除/冻结 `planner.ts`、`scheduler.ts`、`delegation-service.ts`、`state/task-state-machine.ts`、`state/types.ts`、`session-tracker.ts`、`captain-turn-guard.ts`
3. 清理 import、工具定义、CLI 任务治理入口、RPC task 端点
4. 迁移仍需使用的纯函数（如 notify、knowledge 注入）到新归属

**验收**：
- 全量测试、typecheck、build 全绿
- 无旧模块 import 残留
- 旧工具名不再注册

**验证命令**：
```bash
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e:harness
```

### T14 文档与发布配置

**步骤**：
1. 更新 README：插件定位、安装方式、团队配置、执行器说明
2. 更新 doc 11/12/13 状态为“已实施”
3. web profile 增加 fork 插件行，移除旧 dsh-agent-teams 残留
4. 记录 rc.2 验证矩阵与已知限制

**验收**：
- 从零安装说明可执行
- 当前 web profile 冒烟无回归

**验证命令**：
```bash
pnpm build
dsh --profile web --dump-config
```

### T15 alpha 预研线（延后）

**目标**：为未来升级 alpha 做准备，不影响主线。

**步骤**：
1. 新建 `web-alpha` profile
2. 官方 alpha bundle 启动验证
3. 逐插件适配 `dsh-client-runtime` 移除、labels、斜杠端点、Remote Gateway
4. fork peer deps 升 alpha 后跑 verify
5. 验证 childId / subagent:end / 标准 ACP resume

**验收**：
- alpha profile 全功能冒烟
- 第 11 文档第 6 节风险项逐项关闭

**验证命令**：
```bash
# 在 deepseek-harness 源码构建后
dsh --profile web-alpha --dump-config
```

## 3. Definition of Done

一个任务完成必须同时满足：

1. 代码通过该任务指定的测试/构建命令；
2. 无新增 lint 错误（允许存量告警）；
3. 相关文档同步更新；
4. 无未解释的测试跳过。

整个迁移完成必须满足：

1. spawn/fork/acp 三种执行器各跑通一个最小 DAG；
2. 知识注入、反思沉淀在真实流程可见；
3. 会话启用/复用/多会话隔离符合决策文档；
4. 旧任务引擎模块已退役且全量回归绿；
5. 当前 rc.2 插件生态零回归。

## 4. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| fork 补丁破坏其原语义 | 团队流程回归 | T3 前先全量验证，再逐项加钩子 |
| ACP transport 状态回写与 fork 并发锁冲突 | 任务状态错误 | 主机侧回写复用 fork 锁与 attemptId 校验 |
| yaml→profile 字段遗漏 | 建队配置不符 | T5 用真实 changan yaml 做快照测试 |
| 知识注入过长挤占上下文 | 成员输出质量下降 | 注入长度上限 + 分层限制 |
| 旧模块退役牵连图谱/RPC | 全量回归红 | T13 拆小步，逐模块删除 |
| rc.2 与 fork peer 版本偏差 | 构建失败 | T1 先行验证并记录偏差 |
| alpha 未发布 API 再变 | 预研线返工 | P9 延后，不与主线并行 |
