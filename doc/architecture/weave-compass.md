# Weave 罗盘

## 方向

Weave 是 DSH 之上的多智能体协作框架。团队是核心，知识是资产，代码图谱是上下文。

## 原则

1. 团队模板全局统一，团队实例项目级隔离。
2. 通信必须 mailbox，不靠轮询。
3. 值守必须事件驱动，及时响应。
4. 子代理不得重复创建。
5. 反思/记忆必须进入知识库。
6. 页面必须稳定，空闲零拉取。

## 当前坐标

- 分支：`restore/own-team-engine`
- 已有：旧团队引擎、代码图谱、RPC、Web 客户端
- 缺：ProjectTeamStore / Mailbox / DispatchGuard / OnDutyController

## 下一站

1. ProjectTeamStore
2. Mailbox
3. DispatchGuard
4. OnDutyController
5. ReflectionSink
6. Team Tab 稳定化
7. deepseek-zcode-test 团队端到端测试

## 禁止事项

- 禁止再回 dsh-agent-teams fork 依赖。
- 禁止把反思写入团队目录。
- 禁止对同一任务重复 start 子代理。
- 禁止用轮询代替事件唤醒。
