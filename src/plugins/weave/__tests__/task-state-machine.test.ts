import { describe, expect, it } from 'vitest'
import {
  TaskStateMachine,
  TASK_TRANSITIONS,
  FAILURE_TERMINALS,
  MAX_ACTIVATION_ITERATIONS,
} from '../state/task-state-machine.js'
import { TASK_STATUSES } from '../state/types.js'
import type { TaskDag, TaskRecord, TaskStatus } from '../state/types.js'
import { WeaveError } from '../state/weave-error.js'

const makeTask = (overrides: Partial<TaskRecord> & { id: string }): TaskRecord => ({
  session_id: 'sess-1',
  team_id: 'team-1',
  project_id: 'proj-1',
  version: 'v1',
  description: 'desc',
  dependencies: [],
  assigned_agent: null,
  executor: null,
  status: 'WAITING',
  revision_count: 0,
  max_revisions: 5,
  feedback_timeout_seconds: 1800,
  feedback_expires_at: null,
  skip_override: false,
  skip_reason: null,
  fail_count: 0,
  result: null,
  error_type: null,
  created_at: '2026-08-25T00:00:00.000Z',
  updated_at: '2026-08-25T00:00:00.000Z',
  ...overrides,
})

const makeDag = (tasks: TaskRecord[], edges: TaskDag['edges'] = []): TaskDag => ({
  dag_id: 'dag-test',
  tasks,
  edges,
  status: 'running',
})

/** 链式 DAG：t001 → t002 → ... → t00N（t[i] 依赖 t[i-1]） */
const makeChain = (n: number, startStatus: TaskStatus = 'WAITING'): TaskRecord[] =>
  Array.from({ length: n }, (_, i) =>
    makeTask({
      id: `t${String(i + 1).padStart(3, '0')}`,
      status: i === 0 ? startStatus : 'WAITING',
      dependencies: i === 0 ? [] : [`t${String(i).padStart(3, '0')}`],
    }),
  )

describe('任务状态机：14 态与 32 条转移', () => {
  it('枚举包含 TDD 2.1.1 全部 14 个状态且互异', () => {
    expect(TASK_STATUSES).toHaveLength(14)
    expect(new Set(TASK_STATUSES).size).toBe(14)
    for (const s of [
      'WAITING', 'BLOCKED', 'RUNNING', 'COMPLETED', 'AWAITING_FEEDBACK', 'REVISION_RUNNING',
      'CLOSED', 'FAILED', 'BANNED', 'LOOP_TERMINATED', 'INTERRUPTED', 'CANCELLED', 'SKIPPED',
      'COOLDOWN',
    ] as const) {
      expect(TASK_STATUSES).toContain(s)
    }
  })

  it('合法转移恰好 32 条，两端均为 14 态内状态，且无重复', () => {
    expect(TASK_TRANSITIONS).toHaveLength(32)
    const seen = new Set<string>()
    for (const t of TASK_TRANSITIONS) {
      expect(TASK_STATUSES).toContain(t.from)
      expect(TASK_STATUSES).toContain(t.to)
      const key = `${t.from}>${t.to}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
      expect(TaskStateMachine.canTransition(t.from, t.to)).toBe(true)
    }
  })

  it('32 条转移与 TDD §2.1.5 权威矩阵逐一对应（传播/重激活为派生规则，不计入矩阵）', () => {
    // TDD §2.1.5 权威矩阵 #1-#32（2026-08-25 第 3 轮修订，t29 对齐）
    const expected: ReadonlyArray<[TaskStatus, TaskStatus]> = [
      ['WAITING', 'BLOCKED'], ['BLOCKED', 'WAITING'], ['WAITING', 'RUNNING'],
      ['RUNNING', 'COMPLETED'], ['RUNNING', 'FAILED'], ['RUNNING', 'BANNED'],
      ['RUNNING', 'LOOP_TERMINATED'], ['RUNNING', 'INTERRUPTED'], ['RUNNING', 'CANCELLED'],
      ['COMPLETED', 'AWAITING_FEEDBACK'], ['AWAITING_FEEDBACK', 'REVISION_RUNNING'],
      ['AWAITING_FEEDBACK', 'CLOSED'], ['AWAITING_FEEDBACK', 'CANCELLED'],
      ['REVISION_RUNNING', 'COMPLETED'], ['REVISION_RUNNING', 'FAILED'], ['REVISION_RUNNING', 'CANCELLED'],
      ['CLOSED', 'AWAITING_FEEDBACK'],
      ['FAILED', 'WAITING'], ['FAILED', 'SKIPPED'],
      ['BANNED', 'COOLDOWN'], ['BANNED', 'SKIPPED'],
      ['COOLDOWN', 'WAITING'], ['COOLDOWN', 'SKIPPED'],
      ['LOOP_TERMINATED', 'WAITING'], ['LOOP_TERMINATED', 'SKIPPED'],
      ['INTERRUPTED', 'WAITING'], ['INTERRUPTED', 'SKIPPED'], ['INTERRUPTED', 'CANCELLED'],
      ['CANCELLED', 'WAITING'], ['CANCELLED', 'SKIPPED'],
      ['WAITING', 'CANCELLED'], ['BLOCKED', 'CANCELLED'],
    ]
    expect(expected).toHaveLength(32)
    for (const [from, to] of expected) {
      expect(TaskStateMachine.canTransition(from, to), `${from} → ${to}`).toBe(true)
    }
    const actual = new Set(TASK_TRANSITIONS.map((t) => `${t.from}>${t.to}`))
    for (const [from, to] of expected) {
      expect(actual.has(`${from}>${to}`), `${from} → ${to}`).toBe(true)
    }
  })

  it('全部 14 态（含 COOLDOWN）均出现在矩阵；传播/重激活边与 BANNED→WAITING 不在矩阵中', () => {
    const touched = new Set<TaskStatus>()
    for (const t of TASK_TRANSITIONS) {
      touched.add(t.from)
      touched.add(t.to)
    }
    for (const st of TASK_STATUSES) {
      expect(touched.has(st), `状态 ${st} 未出现在任何转移中`).toBe(true)
    }
    // 这些转移已改为派生规则/移除（t29 对齐 TDD §2.1.5）
    for (const [from, to] of [
      ['BANNED', 'WAITING'],
      ['WAITING', 'SKIPPED'],
      ['BLOCKED', 'SKIPPED'],
      ['SKIPPED', 'WAITING'],
      ['SKIPPED', 'BLOCKED'],
    ] as const) {
      expect(TaskStateMachine.canTransition(from, to), `${from}→${to} 应为派生/非法`).toBe(false)
    }
    // 新增（t29）：修订失败/取消、COOLDOWN 进出
    expect(TaskStateMachine.canTransition('REVISION_RUNNING', 'FAILED')).toBe(true)
    expect(TaskStateMachine.canTransition('REVISION_RUNNING', 'CANCELLED')).toBe(true)
    expect(TaskStateMachine.canTransition('BANNED', 'COOLDOWN')).toBe(true)
    expect(TaskStateMachine.canTransition('COOLDOWN', 'WAITING')).toBe(true)
    expect(TaskStateMachine.canTransition('COOLDOWN', 'SKIPPED')).toBe(true)
  })
})

describe('转移执行与非法转移拒绝', () => {
  it('主路径全链路可转移：WAITING→RUNNING→COMPLETED→AWAITING_FEEDBACK→REVISION_RUNNING→COMPLETED', () => {
    let s: TaskStatus = 'WAITING'
    s = TaskStateMachine.transition(s, 'RUNNING')
    s = TaskStateMachine.transition(s, 'COMPLETED')
    s = TaskStateMachine.transition(s, 'AWAITING_FEEDBACK')
    s = TaskStateMachine.transition(s, 'REVISION_RUNNING')
    s = TaskStateMachine.transition(s, 'COMPLETED')
    expect(s).toBe('COMPLETED')
  })

  it('AC-TASK-002：WAITING 直接置 CLOSED 被拒绝，返回 invalid_status_transition', () => {
    expect(TaskStateMachine.canTransition('WAITING', 'CLOSED')).toBe(false)
    let caught: WeaveError | undefined
    try {
      TaskStateMachine.transition('WAITING', 'CLOSED')
    } catch (e) {
      caught = e as WeaveError
    }
    expect(caught).toBeInstanceOf(WeaveError)
    expect(caught?.code).toBe('invalid_status_transition')
    expect(caught?.details).toMatchObject({ from: 'WAITING', to: 'CLOSED' })
  })

  it('代表性非法转移全部被拒', () => {
    const illegal: ReadonlyArray<[TaskStatus, TaskStatus]> = [
      ['WAITING', 'CLOSED'],
      ['COMPLETED', 'RUNNING'],
      ['RUNNING', 'BLOCKED'],
      ['RUNNING', 'AWAITING_FEEDBACK'],
      ['SKIPPED', 'COMPLETED'],
      ['CLOSED', 'RUNNING'],
      ['CLOSED', 'COMPLETED'],
      ['FAILED', 'COMPLETED'],
      ['FAILED', 'RUNNING'],
      ['BANNED', 'COMPLETED'],
      ['BANNED', 'WAITING'],
      ['LOOP_TERMINATED', 'COMPLETED'],
      ['CANCELLED', 'COMPLETED'],
      ['WAITING', 'COOLDOWN'],
      ['WAITING', 'SKIPPED'],
      ['BLOCKED', 'SKIPPED'],
      ['SKIPPED', 'WAITING'],
      ['SKIPPED', 'BLOCKED'],
      ['COMPLETED', 'WAITING'],
      ['RUNNING', 'WAITING'],
    ]
    for (const [from, to] of illegal) {
      expect(TaskStateMachine.canTransition(from, to), `${from} → ${to}`).toBe(false)
      expect(() => TaskStateMachine.transition(from, to), `${from} → ${to}`).toThrow(
        /不允许的任务状态转移/,
      )
    }
  })

  it('canTransition 与 transition 对 14×14 全组合一致性', () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const can = TASK_TRANSITIONS.some((t) => t.from === from && t.to === to)
        expect(TaskStateMachine.canTransition(from, to)).toBe(can)
      }
    }
  })

  it('失败终态恰为 FAILED/BANNED/LOOP_TERMINATED/CANCELLED 四个', () => {
    expect(FAILURE_TERMINALS).toEqual(['FAILED', 'BANNED', 'LOOP_TERMINATED', 'CANCELLED'])
    for (const s of TASK_STATUSES) {
      expect(TaskStateMachine.isFailureTerminal(s)).toBe(
        s === 'FAILED' || s === 'BANNED' || s === 'LOOP_TERMINATED' || s === 'CANCELLED',
      )
    }
  })
})

describe('失败传播（AC-TASK-003）', () => {
  it('失败终态使全部 WAITING/BLOCKED 下游 SKIPPED，非下游与已终态任务不受影响', () => {
    const dag = makeDag([
      makeTask({ id: 'A', status: 'FAILED' }),
      makeTask({ id: 'B', status: 'WAITING', dependencies: ['A'] }),
      makeTask({ id: 'C', status: 'BLOCKED', dependencies: ['B'] }),
      makeTask({ id: 'D', status: 'WAITING', dependencies: [] }),
      makeTask({ id: 'E', status: 'COMPLETED', dependencies: ['A'] }),
      makeTask({ id: 'F', status: 'RUNNING', dependencies: ['A'] }),
    ])
    const result = TaskStateMachine.propagateFailure(dag, 'A')
    expect(dag.tasks.find((t) => t.id === 'B')?.status).toBe('SKIPPED')
    expect(dag.tasks.find((t) => t.id === 'C')?.status).toBe('SKIPPED')
    expect(dag.tasks.find((t) => t.id === 'D')?.status).toBe('WAITING')
    expect(dag.tasks.find((t) => t.id === 'E')?.status).toBe('COMPLETED')
    expect(dag.tasks.find((t) => t.id === 'F')?.status).toBe('RUNNING')
    expect(result.skipped).toEqual(['B', 'C'])
    expect(result.changed).toBe(2)
    expect(result.iterations).toBeGreaterThan(0)
  })

  it('四个失败终态（FAILED/BANNED/LOOP_TERMINATED/CANCELLED）均触发传播；SKIPPED 下游继续传播', () => {
    for (const terminal of FAILURE_TERMINALS) {
      const dag = makeDag([
        makeTask({ id: 'A', status: terminal }),
        makeTask({ id: 'B', status: 'WAITING', dependencies: ['A'] }),
      ])
      TaskStateMachine.propagateFailure(dag, 'A')
      expect(dag.tasks.find((t) => t.id === 'B')?.status, `root=${terminal}`).toBe('SKIPPED')
    }
    const chain = makeDag([
      makeTask({ id: 'A', status: 'FAILED' }),
      makeTask({ id: 'B', status: 'WAITING', dependencies: ['A'] }),
      makeTask({ id: 'C', status: 'WAITING', dependencies: ['B'] }),
      makeTask({ id: 'D', status: 'WAITING', dependencies: ['C'] }),
    ])
    TaskStateMachine.propagateFailure(chain, 'A')
    expect(chain.tasks.map((t) => t.id + ':' + t.status)).toEqual([
      'A:FAILED', 'B:SKIPPED', 'C:SKIPPED', 'D:SKIPPED',
    ])
  })

  it('SKIPPED（含 override）上游不反向重激活其下游', () => {
    const dag = makeDag([
      makeTask({ id: 'A', status: 'WAITING' }),
      makeTask({ id: 'B', status: 'SKIPPED', skip_override: true, dependencies: ['A'] }),
      makeTask({ id: 'C', status: 'WAITING', dependencies: ['B'] }),
    ])
    TaskStateMachine.propagateFailure(dag, 'B')
    expect(dag.tasks.find((t) => t.id === 'C')?.status).toBe('SKIPPED')
    expect(dag.tasks.find((t) => t.id === 'B')?.status).toBe('SKIPPED')
  })

  it('任务不存在时抛 task_not_found', () => {
    const dag = makeDag([makeTask({ id: 'A', status: 'FAILED' })])
    expect(() => TaskStateMachine.propagateFailure(dag, 'nope')).toThrowError(
      expect.objectContaining({ code: 'task_not_found' }),
    )
  })

  it('迭代保护 100 次：101 条边链的最末端保持 WAITING', () => {
    const tasks = makeChain(102, 'FAILED')
    const dag = makeDag(tasks)
    const result = TaskStateMachine.propagateFailure(dag, 't001')
    expect(result.iterations).toBe(MAX_ACTIVATION_ITERATIONS)
    expect(tasks[100]?.status).toBe('SKIPPED') // t101 在第 100 轮被跳过
    expect(tasks[101]?.status).toBe('WAITING') // t102 超出保护上限
  })
})

describe('SKIPPED 重激活（AC-TASK-004 / AC-TASK-005）', () => {
  it('上游 retry（WAITING）后：非 override 下游恢复 BLOCKED；依赖完成后恢复 WAITING', () => {
    const dag = makeDag([
      makeTask({ id: 'A', status: 'WAITING' }),
      makeTask({ id: 'B', status: 'SKIPPED', dependencies: ['A'] }),
    ])
    TaskStateMachine.reactivateSkipped(dag, 'A')
    expect(dag.tasks.find((t) => t.id === 'B')?.status).toBe('BLOCKED')

    // A 完成 → B 的 BLOCKED→WAITING 走状态机正常转移（Orchestrator 调度）
    dag.tasks.find((t) => t.id === 'A')!.status = 'COMPLETED'
    const b = dag.tasks.find((t) => t.id === 'B')!
    expect(TaskStateMachine.canTransition('BLOCKED', 'WAITING')).toBe(true)
    b.status = TaskStateMachine.transition('BLOCKED', 'WAITING')
    expect(b.status).toBe('WAITING')
  })

  it('override 的 SKIPPED 即使上游恢复也保持 SKIPPED', () => {
    const dag = makeDag([
      makeTask({ id: 'A', status: 'WAITING' }),
      makeTask({ id: 'B', status: 'SKIPPED', skip_override: true, skip_reason: 'manual', dependencies: ['A'] }),
    ])
    TaskStateMachine.reactivateSkipped(dag, 'A')
    expect(dag.tasks.find((t) => t.id === 'B')?.status).toBe('SKIPPED')
  })

  it('无依赖的 SKIPPED 非 override 任务可自行重激活为 WAITING', () => {
    const dag = makeDag([makeTask({ id: 'B', status: 'SKIPPED', dependencies: [] })])
    const r = TaskStateMachine.reactivateSkipped(dag, 'B')
    expect(r.reactivated).toEqual(['B'])
    expect(dag.tasks.find((t) => t.id === 'B')?.status).toBe('WAITING')
  })

  it('链式重激活逐级恢复：A→B→C，依赖未完成时限 BLOCKED', () => {
    const dag = makeDag([
      makeTask({ id: 'A', status: 'WAITING' }),
      makeTask({ id: 'B', status: 'SKIPPED', dependencies: ['A'] }),
      makeTask({ id: 'C', status: 'SKIPPED', dependencies: ['B'] }),
      makeTask({ id: 'D', status: 'WAITING', dependencies: [] }),
    ])
    TaskStateMachine.reactivateSkipped(dag, 'A')
    expect(dag.tasks.find((t) => t.id === 'B')?.status).toBe('BLOCKED')
    expect(dag.tasks.find((t) => t.id === 'C')?.status).toBe('BLOCKED')
    expect(dag.tasks.find((t) => t.id === 'D')?.status).toBe('WAITING') // 非下游不受影响
  })

  it('重激活迭代保护 100 次：101 条边链的最末端保持 SKIPPED', () => {
    const tasks = makeChain(102, 'FAILED')
    const dag = makeDag(tasks)
    const r1 = TaskStateMachine.propagateFailure(dag, 't001')
    expect(r1.iterations).toBe(MAX_ACTIVATION_ITERATIONS)
    expect(r1.skipped).toHaveLength(100)
    expect(tasks[100]?.status).toBe('SKIPPED') // t101 恰好第 100 轮被跳过
    expect(tasks[101]?.status).toBe('WAITING') // t102 被传播上限拦截，尚未跳过
    tasks[101]!.status = 'SKIPPED' // 模拟完整跳过域
    tasks[0]!.status = 'WAITING' // 上游 retry
    const r2 = TaskStateMachine.reactivateSkipped(dag, 't001')
    expect(r2.iterations).toBe(MAX_ACTIVATION_ITERATIONS)
    expect(tasks[100]?.status).toBe('BLOCKED') // t101 在第 100 轮恢复
    expect(tasks[101]?.status).toBe('SKIPPED') // t102 被重激活保护上限拦截
  })

  it('override 阻断链式恢复：其后代保持 SKIPPED', () => {
    const dag = makeDag([
      makeTask({ id: 'A', status: 'WAITING' }),
      makeTask({ id: 'B', status: 'SKIPPED', dependencies: ['A'] }),
      makeTask({ id: 'C', status: 'SKIPPED', skip_override: true, dependencies: ['B'] }),
      makeTask({ id: 'D', status: 'SKIPPED', dependencies: ['C'] }),
    ])
    TaskStateMachine.reactivateSkipped(dag, 'A')
    expect(dag.tasks.find((t) => t.id === 'B')?.status).toBe('BLOCKED')
    expect(dag.tasks.find((t) => t.id === 'C')?.status).toBe('SKIPPED')
    expect(dag.tasks.find((t) => t.id === 'D')?.status).toBe('SKIPPED')
  })
})
