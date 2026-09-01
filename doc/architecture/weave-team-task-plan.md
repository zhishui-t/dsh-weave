# Weave 团队运行时任务规划

## 任务列表

### T1 ProjectTeamStore
- 依赖：无
- 验收：单测覆盖 save/load/list/archive/snapshot
- 产物：`team/project-team-store.ts`

### T2 Mailbox
- 依赖：T1
- 验收：claim/ack/release/unread 测试
- 产物：`team/mailbox.ts`

### T3 DispatchGuard
- 依赖：T1、T2
- 验收：同一 taskId 不重复派发
- 产物：`scheduler.ts` 改造

### T4 OnDutyController
- 依赖：T2、T3
- 验收：成员事件及时注入；无任务允许结束回合
- 产物：`core/on-duty.ts`

### T5 ReflectionSink
- 依赖：T3
- 验收：反思写入 `~/.dsh/knowledge`
- 产物：`reflection-sink.ts`

### T6 Team Tab 稳定化
- 依赖：T1
- 验收：页面稳定，不闪烁
- 产物：`src/client/index.ts` 改造

### T7 旧数据迁移
- 依赖：T1
- 验收：旧 team_bindings 可导入项目目录
- 产物：`migration.ts`

### T8 端到端测试
- 依赖：T1-T7
- 测试团队：`deepseek-zcode-test`
- 验收：完整跑通启用→规划→执行→反思→页面显示

## 依赖关系

```text
T1 → T2 → T3 → T4
            ↘ T5
T1 → T6
T1 → T7
T1-T7 → T8
```

## 优先级

P0：
- T1、T3、T4

P1：
- T2、T5、T6

P2：
- T7

## 风险

- fork/spawn 快速 settle 导致重复派发：T3 必须最先修。
- 团队页签闪烁：T6 依赖稳定快照。
- 旧数据迁移失败：保留原数据，只读导入。
