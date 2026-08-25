import { WeaveError } from './weave-error.js'
import type { TaskDag, TaskRecord, TaskStatus } from './types.js'

/** 失败终态：FAILED / BANNED / LOOP_TERMINATED / CANCELLED（架构 4.2.2），触发下游 SKIPPED 传播 */
export const FAILURE_TERMINALS: readonly TaskStatus[] = [
  'FAILED',
  'BANNED',
  'LOOP_TERMINATED',
  'CANCELLED',
] as const

const FAILURE_TERMINAL_SET: ReadonlySet<TaskStatus> = new Set(FAILURE_TERMINALS)

/** SKIPPED 重激活 / 失败传播的迭代保护上限（AC-TASK-005，100 次）。 */
export const MAX_ACTIVATION_ITERATIONS = 100

export interface StatusTransition {
  from: TaskStatus
  to: TaskStatus
}

/**
 * 32 条合法转移（TDD §2.1.5 权威矩阵，t29 对齐）。
 * 失败传播（WAITING/BLOCKED→SKIPPED，AC-TASK-003）与 SKIPPED 重激活
 * （恢复 WAITING/BLOCKED，AC-TASK-004）为**派生规则**（propagateFailure /
 * reactivateSkipped），不计入本矩阵；COOLDOWN 为第 14 态，经 BANNED→COOLDOWN→
 * WAITING（冷却结束）+ COOLDOWN→SKIPPED（冷却期人工 skip）进出。
 */
export const TASK_TRANSITIONS: readonly StatusTransition[] = [
  // 依赖图调度
  { from: 'WAITING', to: 'BLOCKED' },
  { from: 'BLOCKED', to: 'WAITING' },
  { from: 'WAITING', to: 'RUNNING' },
  // RUNNING 结局
  { from: 'RUNNING', to: 'COMPLETED' },
  { from: 'RUNNING', to: 'FAILED' },
  { from: 'RUNNING', to: 'BANNED' },
  { from: 'RUNNING', to: 'LOOP_TERMINATED' },
  { from: 'RUNNING', to: 'INTERRUPTED' },
  { from: 'RUNNING', to: 'CANCELLED' },
  // 保温期
  { from: 'COMPLETED', to: 'AWAITING_FEEDBACK' },
  { from: 'AWAITING_FEEDBACK', to: 'REVISION_RUNNING' },
  { from: 'REVISION_RUNNING', to: 'COMPLETED' },
  { from: 'REVISION_RUNNING', to: 'FAILED' }, // 修订执行失败/超时（ME-5：#15）
  { from: 'REVISION_RUNNING', to: 'CANCELLED' }, // 修订取消（ME-5：#16）
  { from: 'AWAITING_FEEDBACK', to: 'CLOSED' },
  { from: 'AWAITING_FEEDBACK', to: 'CANCELLED' },
  { from: 'CLOSED', to: 'AWAITING_FEEDBACK' }, // 24h 内 reopen
  // 失败终态 → retry / skip / cancel
  { from: 'FAILED', to: 'WAITING' },
  { from: 'FAILED', to: 'SKIPPED' },
  { from: 'BANNED', to: 'COOLDOWN' }, // 冷却开始（BAN expiry / 手动解除）
  { from: 'BANNED', to: 'SKIPPED' },
  { from: 'LOOP_TERMINATED', to: 'WAITING' },
  { from: 'LOOP_TERMINATED', to: 'SKIPPED' },
  { from: 'INTERRUPTED', to: 'WAITING' },
  { from: 'INTERRUPTED', to: 'SKIPPED' },
  { from: 'INTERRUPTED', to: 'CANCELLED' },
  { from: 'CANCELLED', to: 'WAITING' },
  { from: 'CANCELLED', to: 'SKIPPED' },
  // COOLDOWN（第 14 态）：冷却结束 / 冷却期人工 skip
  { from: 'COOLDOWN', to: 'WAITING' },
  { from: 'COOLDOWN', to: 'SKIPPED' },
  // 主动取消
  { from: 'WAITING', to: 'CANCELLED' },
  { from: 'BLOCKED', to: 'CANCELLED' },
  // 注：失败传播（WAITING/BLOCKED→SKIPPED）与 SKIPPED 重激活（→WAITING/BLOCKED）
  // 为派生规则，见 propagateFailure / reactivateSkipped（AC-TASK-003/004），不计入矩阵。
]

export interface PropagationResult {
  iterations: number
  changed: number
  skipped: string[]
}

export interface ReactivationResult {
  iterations: number
  changed: number
  reactivated: string[]
}

/**
 * 任务状态机：唯一权威的转移判定 + 失败传播 / SKIPPED 重激活。
 * 纯函数式实现（不持有任务状态），便于测试与序列化。
 */
export class TaskStateMachine {
  static readonly TRANSITIONS: readonly StatusTransition[] = TASK_TRANSITIONS
  static readonly MAX_ITERATIONS = MAX_ACTIVATION_ITERATIONS

  static isFailureTerminal(status: TaskStatus): boolean {
    return FAILURE_TERMINAL_SET.has(status)
  }

  /** 该转移是否合法（32 条矩阵）。 */
  static canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return TASK_TRANSITIONS.some((t) => t.from === from && t.to === to)
  }

  /** 执行转移；非法转移抛 WeaveError('invalid_status_transition')（AC-TASK-002）。 */
  static transition(from: TaskStatus, to: TaskStatus): TaskStatus {
    if (!TaskStateMachine.canTransition(from, to)) {
      throw new WeaveError(
        'invalid_status_transition',
        `不允许的任务状态转移: ${from} → ${to}`,
        { from, to },
      )
    }
    return to
  }

  /** 从 failedTaskId 出发向所有 WAITING/BLOCKED 下游传播 SKIPPED，迭代至无变化（上限 100）。 */
  static propagateFailure(dag: TaskDag, failedTaskId: string): PropagationResult {
    const byId = TaskStateMachine.#index(dag)
    if (!byId.has(failedTaskId)) {
      throw new WeaveError('task_not_found', `任务不存在: ${failedTaskId}`, { taskId: failedTaskId })
    }
    const downstreamOf = TaskStateMachine.#downstream(dag)

    const skipped: string[] = []
    let changed = true
    let iterations = 0
    while (changed && iterations < MAX_ACTIVATION_ITERATIONS) {
      changed = false
      iterations++
      const snapshot = new Map(dag.tasks.map((t) => [t.id, t.status]))
      for (const task of dag.tasks) {
        if (task.status !== 'WAITING' && task.status !== 'BLOCKED') continue
        const deps = task.dependencies
        const dead = deps.some((d) => {
          const s = snapshot.get(d)
          return s === 'SKIPPED' || (s !== undefined && FAILURE_TERMINAL_SET.has(s))
        })
        if (dead) {
          task.status = 'SKIPPED'
          skipped.push(task.id)
          changed = true
        }
      }
      void downstreamOf
    }
    return { iterations, changed: skipped.length, skipped }
  }

  /**
   * 上游 retry/skip 后，重激活其下游中非 override 的 SKIPPED 任务：
   * 依赖全部 COMPLETED/CLOSED → WAITING，否则（依赖仍待完成）→ BLOCKED；
   * 任一依赖仍是失败终态或 SKIPPED（含 override）→ 保持 SKIPPED。迭代上限 100（AC-TASK-005）。
   */
  static reactivateSkipped(dag: TaskDag, upstreamTaskId: string): ReactivationResult {
    const byId = TaskStateMachine.#index(dag)
    if (!byId.has(upstreamTaskId)) {
      throw new WeaveError('task_not_found', `任务不存在: ${upstreamTaskId}`, { taskId: upstreamTaskId })
    }
    const reachable = TaskStateMachine.#downstreamFrom(dag, upstreamTaskId)

    const reactivated: string[] = []
    let changed = true
    let iterations = 0
    while (changed && iterations < MAX_ACTIVATION_ITERATIONS) {
      changed = false
      iterations++
      const snapshot = new Map(dag.tasks.map((t) => [t.id, t.status]))
      for (const task of dag.tasks) {
        if (task.status !== 'SKIPPED' || task.skip_override) continue
        if (!reachable.has(task.id)) continue
        const deps = task.dependencies
        const blockedByDead = deps.some((d) => {
          const s = snapshot.get(d)
          return s === 'SKIPPED' || (s !== undefined && FAILURE_TERMINAL_SET.has(s))
        })
        if (blockedByDead) continue
        const allDone =
          deps.length === 0 ||
          deps.every((d) => {
            const s = snapshot.get(d)
            return s === 'COMPLETED' || s === 'CLOSED'
          })
        task.status = allDone ? 'WAITING' : 'BLOCKED'
        reactivated.push(task.id)
        changed = true
      }
    }
    return { iterations, changed: reactivated.length, reactivated }
  }

  /** 构建 id → TaskRecord 索引。 */
  static #index(dag: TaskDag): Map<string, TaskRecord> {
    return new Map(dag.tasks.map((t) => [t.id, t]))
  }

  /** 构建下游邻接（task.dependencies + dag.edges 的并集）。 */
  static #downstream(dag: TaskDag): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>()
    const addEdge = (from: string, to: string) => {
      const set = out.get(from) ?? new Set<string>()
      set.add(to)
      out.set(from, set)
    }
    for (const t of dag.tasks) for (const d of t.dependencies) addEdge(d, t.id)
    for (const e of dag.edges) addEdge(e.from, e.to)
    return out
  }

  /** 从指定任务出发可达的所有下游任务（含自身）。 */
  static #downstreamFrom(dag: TaskDag, rootId: string): Set<string> {
    const downstream = TaskStateMachine.#downstream(dag)
    const reachable = new Set<string>()
    const stack = [rootId]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (cur === undefined || reachable.has(cur)) continue
      reachable.add(cur)
      for (const next of downstream.get(cur) ?? []) stack.push(next)
    }
    return reachable
  }
}
