# Weave 罗盘

## 方向

Weave 是 DSH 之上的多智能体协作框架。团队是核心，治理是骨架；知识资产与图谱由子项目 Prism 承接（控制面），Weave 专职调度运行时。

## 原则

1. 团队模板全局统一，团队实例项目级隔离。
2. 通信必须 mailbox/事件边沿（wait_dag_change、成员消息唤醒），不靠轮询。
3. 值守必须事件驱动，及时响应。
4. 子代理不得重复创建。
5. 反思/记忆必须进入知识暂存区，主会话审核后落 Prism 知识库（先审后发）。
6. 页面必须稳定，空闲零拉取。

## 当前坐标

- 分支：`master_prism_0912`（prism 接入 + pull 模型调度）
- 调度已切 pull 模型：持久成员自拉任务（官方 agent-team 交互面 + weave 治理内核），见 doc/architecture/pull-scheduling.md
- 已接回自有团队引擎：delegation / planner / scheduler
- 已实现：ProjectTeamStore、Mailbox、DispatchGuard、OnDutyController、ReflectionSink
- 已恢复：会话内「Weave 团队」页签与 Dashboard
- 已移交 Prism：知识库、知识图谱、代码图谱、文档转换、Obsidian（weave 侧保留注入/暂存/薄触发钩子）
- 测试：单元 688 通过；Playwright harness/live 全绿

## 下一站

1. `deepseek-zcode-test` 真实任务端到端成功链路（等待模型配额）
2. Web 团队页签继续向 ActivityPanel 观感对齐
3. 发布前清理与文档冻结
