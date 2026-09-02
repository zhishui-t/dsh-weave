import { describe, expect, it } from 'vitest'
import { TaskStatusNotifier, type TaskStatusChange } from '../scheduling/task-status-notifier.js'

const change = (overrides: Partial<TaskStatusChange> = {}): TaskStatusChange => ({
  taskId: 'task-1',
  dagId: 'dag-1',
  sessionId: 'sess-1',
  subject: '实现代码',
  from: 'RUNNING',
  to: 'CANCELLED',
  actor: 'scheduler',
  source: 'task_cancel',
  ...overrides,
})

const collector = (): { notified: Array<{ sessionId: string; text: string }> } => {
  const notified: Array<{ sessionId: string; text: string }> = []
  return { notified }
}

describe('TaskStatusNotifier（doc/05 §6.4 P1-D 单出口）', () => {
  it('单条通知：文案含 subject/from/to/source，按 sessionId 路由', () => {
    const { notified } = collector()
    const notifier = new TaskStatusNotifier({ notify: (sessionId, text) => notified.push({ sessionId, text }) })
    notifier.notify(change({ to: 'CANCELLED', source: 'task_cancel' }))
    expect(notified).toEqual([
      { sessionId: 'sess-1', text: '[weave] 任务「实现代码」RUNNING → CANCELLED（task_cancel）' },
    ])
  })

  it('subject 缺省/空白回退 taskId', () => {
    const { notified } = collector()
    const notifier = new TaskStatusNotifier({ notify: (sessionId, text) => notified.push({ sessionId, text }) })
    notifier.notify(change({ subject: undefined, to: 'FAILED', source: 'task_patch' }))
    notifier.notify(change({ subject: '   ', to: 'FAILED', source: 'task_patch' }))
    expect(notified.every((n) => n.text.includes('「task-1」'))).toBe(true)
  })

  it('回声抑制：captain/user 动作默认不通知；echoSelfActions=true 时通知', () => {
    const { notified } = collector()
    const notifier = new TaskStatusNotifier({ notify: (sessionId, text) => notified.push({ sessionId, text }) })
    notifier.notify(change({ actor: 'captain', source: 'task_skip' }))
    notifier.notify(change({ actor: 'user', source: 'task_cancel' }))
    expect(notified).toHaveLength(0)

    const echoing = new TaskStatusNotifier({ notify: (sessionId, text) => notified.push({ sessionId, text }), echoSelfActions: true })
    echoing.notify(change({ actor: 'user', source: 'task_cancel' }))
    expect(notified).toHaveLength(1)
  })

  it('scheduler/recovery/feedback actor 不受回声抑制影响', () => {
    const { notified } = collector()
    const notifier = new TaskStatusNotifier({ notify: (sessionId, text) => notified.push({ sessionId, text }) })
    notifier.notify(change({ actor: 'scheduler', source: 'task_start', from: 'WAITING', to: 'RUNNING' }))
    notifier.notify(change({ actor: 'recovery', source: 'task_repaired', from: 'BANNED', to: 'WAITING' }))
    notifier.notify(change({ actor: 'feedback', source: 'feedback_revise', from: 'AWAITING_FEEDBACK', to: 'REVISION_RUNNING' }))
    expect(notified).toHaveLength(3)
  })

  it('吞错：notify 回调抛错不冒泡（观察者不得影响治理动作）', () => {
    const notifier = new TaskStatusNotifier({
      notify: () => { throw new Error('session gone') },
    })
    expect(() => notifier.notify(change())).not.toThrow()
    expect(() => notifier.notifyBatch([change(), change({ taskId: 'task-2' })])).not.toThrow()
  })
})

describe('TaskStatusNotifier.notifyBatch（批量合并）', () => {
  it('同 DAG 多条变更合并为一条汇总：计数 + 每项一行', () => {
    const { notified } = collector()
    const notifier = new TaskStatusNotifier({ notify: (sessionId, text) => notified.push({ sessionId, text }) })
    notifier.notifyBatch([
      change({ taskId: 't1', subject: '甲', from: 'RUNNING', to: 'CANCELLED', source: 'ui_cancel' }),
      change({ taskId: 't2', subject: '乙', from: 'WAITING', to: 'SKIPPED', source: 'ui_cancel' }),
      change({ taskId: 't3', subject: '丙', from: 'BLOCKED', to: 'SKIPPED', source: 'ui_cancel' }),
    ])
    expect(notified).toHaveLength(1)
    expect(notified[0]!.sessionId).toBe('sess-1')
    expect(notified[0]!.text).toBe(
      '[weave] 任务图 dag-1 状态变更 3 项：\n' +
      '「甲」RUNNING → CANCELLED（ui_cancel）\n' +
      '「乙」WAITING → SKIPPED（ui_cancel）\n' +
      '「丙」BLOCKED → SKIPPED（ui_cancel）',
    )
  })

  it('超过 10 行折叠计数；回声过滤后计数按可见项计算', () => {
    const { notified } = collector()
    const notifier = new TaskStatusNotifier({ notify: (sessionId, text) => notified.push({ sessionId, text }) })
    const changes = Array.from({ length: 15 }, (_, i) =>
      change({ taskId: `t${i}`, subject: `任务${i}`, from: 'WAITING', to: 'SKIPPED', source: 'close_expired', actor: i === 0 ? 'user' : 'feedback' }),
    )
    notifier.notifyBatch(changes)
    expect(notified).toHaveLength(1)
    // 15 条中第 0 条被回声抑制 → 可见 14 项；展开 10 行 + 1 行折叠
    expect(notified[0]!.text).toContain('状态变更 14 项：')
    expect(notified[0]!.text).toContain('…（其余 4 项折叠）')
    expect(notified[0]!.text.split('\n')).toHaveLength(12) // 头 1 + 10 + 折叠 1
  })

  it('跨 DAG 分组各发一条；回声全滤/空数组不通知', () => {
    const { notified } = collector()
    const notifier = new TaskStatusNotifier({ notify: (sessionId, text) => notified.push({ sessionId, text }) })
    notifier.notifyBatch([
      change({ dagId: 'dag-a', sessionId: 'sess-a', taskId: 't1' }),
      change({ dagId: 'dag-b', sessionId: 'sess-b', taskId: 't2' }),
    ])
    expect(notified).toHaveLength(2)
    expect(notified.map((n) => n.sessionId).sort()).toEqual(['sess-a', 'sess-b'])

    notifier.notifyBatch([change({ actor: 'user' }), change({ actor: 'captain' })])
    expect(notified).toHaveLength(2)
    notifier.notifyBatch([])
    expect(notified).toHaveLength(2)
  })
})
