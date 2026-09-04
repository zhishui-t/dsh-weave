import { DAGS_TABLE_DDL, EDGES_TABLE_DDL } from '../persistence/schemas.js'
import type { WeavePersistence } from '../persistence/persistence.js'
import { TaskStateMachine } from '../state/task-state-machine.js'
import type { TaskDag, TaskEdge, TaskRecord, TaskStatus } from '../state/types.js'
import { WeaveError } from '../state/weave-error.js'
import type { TaskStatusNotifier } from '../scheduling/task-status-notifier.js'
import type { AuditLog } from '../audit/audit-log.js'

/**
 * DAG 持久化仓库（HI-3：tasks.dag_id + dags/edges 表，TDD §2.6.6/2.6.7）。
 * - loadDag：dags + edges + tasks 三表联合读取（无进程内状态）；
 * - cancelTask：按权威状态机校验后写 CANCELLED，并向失败终态下游传播 SKIPPED（AC-TASK-003）。
 * 写入统一走 WeavePersistence 的 SingleWriterQueue。
 */

interface TaskRow {
  id: string
  session_id: string
  team_id: string
  project_id: string
  version: string
  description: string
  dependencies: string
  assigned_agent: string | null
  executor: string | null
  status: string
  revision_count: number
  max_revisions: number
  feedback_timeout_seconds: number
  feedback_expires_at: string | null
  skip_override: number
  skip_reason: string | null
  fail_count: number
  result: string | null
  error_type: string | null
  created_at: string
  updated_at: string
}

interface DagRow {
  dag_id: string
  team_id: string
  project_id: string
  version: string
  difficulty: string
  status: string
  created_at: string
  updated_at: string
}

interface EdgeRow {
  dag_id: string
  from_task_id: string
  to_task_id: string
}

function rowToTask(row: TaskRow): TaskRecord {
  let dependencies: string[] = []
  try {
    const parsed = JSON.parse(row.dependencies) as unknown
    if (Array.isArray(parsed)) dependencies = parsed as string[]
  } catch {
    dependencies = []
  }
  return {
    id: row.id,
    session_id: row.session_id,
    team_id: row.team_id,
    project_id: row.project_id,
    version: row.version,
    description: row.description,
    dependencies,
    assigned_agent: row.assigned_agent,
    executor: row.executor,
    status: row.status as TaskStatus,
    revision_count: row.revision_count,
    max_revisions: row.max_revisions,
    feedback_timeout_seconds: row.feedback_timeout_seconds,
    feedback_expires_at: row.feedback_expires_at,
    skip_override: row.skip_override === 1,
    skip_reason: row.skip_reason,
    fail_count: row.fail_count,
    result: row.result,
    error_type: row.error_type,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** 任务终态判定：失败终态（含取消）或成功终态。 */
const TERMINALS: ReadonlySet<TaskStatus> = new Set([
  'COMPLETED',
  'CLOSED',
  'FAILED',
  'BANNED',
  'LOOP_TERMINATED',
  'INTERRUPTED',
  'CANCELLED',
  'SKIPPED',
])

function dagStatusOf(tasks: TaskRecord[]): TaskDag['status'] {
  if (tasks.length === 0) return 'created'
  if (tasks.every((t) => TERMINALS.has(t.status))) {
    return tasks.some((t) => TaskStateMachine.isFailureTerminal(t.status) || t.status === 'SKIPPED')
      ? 'failed'
      : 'completed'
  }
  return 'running'
}

export function toDagStatus(tasks: TaskRecord[]): TaskDag['status'] {
  return dagStatusOf(tasks)
}

export interface DagRepositoryOptions {
  /** 任务状态变更通知单出口（doc/05 §6.4 P1-D 接线点 4）；未注入则不发电（向后兼容）。 */
  statusNotifier?: TaskStatusNotifier
  /** 审计（同步补 task.status_changed）；未注入则只通知不审计。 */
  audit?: AuditLog
}

export class DagRepository {
  #ready = false
  readonly #statusNotifier?: TaskStatusNotifier
  readonly #audit?: AuditLog

  constructor(
    private readonly persistence: WeavePersistence,
    options: DagRepositoryOptions = {},
  ) {
    this.#statusNotifier = options.statusNotifier
    this.#audit = options.audit
  }

  /** 幂等确保 dags/edges 表存在（兼容早于 HI-3 规格迁移的库）。 */
  async #ensure(): Promise<void> {
    if (this.#ready) return
    await this.persistence.tasks.run((db) => {
      db.exec(DAGS_TABLE_DDL)
      db.exec(EDGES_TABLE_DDL)
    })
    this.#ready = true
  }

  /** 三表联合读取 DAG；不存在抛 task_not_found。 */
  async loadDag(dagId: string): Promise<TaskDag> {
    await this.#ensure()
    const result = await this.persistence.tasks.run((db) => {
      const dag = db.prepare('SELECT * FROM dags WHERE dag_id = ?').get(dagId) as
        | DagRow
        | undefined
      if (!dag) return null
      const taskRows = db
        .prepare('SELECT * FROM tasks WHERE dag_id = ? ORDER BY rowid')
        .all(dagId) as unknown as TaskRow[]
      const edgeRows = db
        .prepare('SELECT * FROM edges WHERE dag_id = ? ORDER BY from_task_id, to_task_id')
        .all(dagId) as unknown as EdgeRow[]
      const edges: TaskEdge[] = edgeRows.map((e) => ({ from: e.from_task_id, to: e.to_task_id }))
      return { dag, taskRows, edges }
    })
    if (!result) {
      throw new WeaveError('task_not_found', `DAG 不存在: ${dagId}`, { dagId })
    }
    const tasks = result.taskRows.map(rowToTask)
    return {
      dag_id: result.dag.dag_id,
      tasks,
      edges: result.edges,
      status: result.dag.status as TaskDag['status'],
    }
  }

  /**
   * 快速取消：状态机校验（WAITING/BLOCKED/RUNNING/INTERRUPTED/AWAITING_FEEDBACK → CANCELLED）
   * 后写 CANCELLED，并向下游传播 SKIPPED；返回更新后的完整 DAG。
   */
  async cancelTask(dagId: string, taskId: string): Promise<TaskDag> {
    await this.#ensure()
    const dag = await this.loadDag(dagId)
    const task = dag.tasks.find((t) => t.id === taskId)
    if (!task) {
      throw new WeaveError('task_not_found', `任务不存在: ${taskId}`, { dagId, taskId })
    }
    if (!TaskStateMachine.canTransition(task.status, 'CANCELLED')) {
      throw new WeaveError(
        'invalid_status_transition',
        `状态 ${task.status} 不允许取消（TDD §2.1.5 矩阵）`,
        { taskId, status: task.status },
      )
    }
    // 传播前状态快照：propagateFailure 会原地改写共享 task 对象，通知/审计的
    // from 必须取快照（否则 SKIPPED 传播项的 from 误报为 SKIPPED）。
    const preStatuses = new Map(dag.tasks.map((t) => [t.id, t.status]))
    const now = new Date().toISOString()
    await this.persistence.tasks.run((db) => {
      db.prepare(`UPDATE tasks SET status = 'CANCELLED', updated_at = ? WHERE id = ?`).run(
        now,
        taskId,
      )
    })
    // 接线点 4（doc/05 §6.4）：主变更单条发电 + 审计（actor=user；面板发起者已知
    // 结果，echoSelfActions=false 时不回声，行为可经注入配置）。
    try {
      this.#statusNotifier?.notify({
        taskId,
        dagId,
        sessionId: task.session_id,
        subject: task.description.split('\n')[0]?.trim() || taskId,
        from: task.status,
        to: 'CANCELLED',
        actor: 'user',
        source: 'ui_cancel',
      })
      await this.#audit?.record({
        type: 'task.status_changed',
        task_id: taskId,
        from: task.status,
        to: 'CANCELLED',
        by: 'user',
      })
    } catch {
      // 通知/审计失败不影响取消本身。
    }
    // 失败终态传播：WAITING/BLOCKED 下游 → SKIPPED（AC-TASK-003，迭代保护 100）
    const next = this.#withStatus(dag, taskId, 'CANCELLED')
    const propagated = TaskStateMachine.propagateFailure(next, taskId)
    if (propagated.skipped.length > 0) {
      await this.persistence.tasks.run((db) => {
        const stmt = db.prepare(`UPDATE tasks SET status = 'SKIPPED', updated_at = ? WHERE id = ?`)
        for (const id of propagated.skipped) {
          stmt.run(now, id)
        }
      })
      // 接线点 4（续）：传播批量合并发电 + 审计（from 取传播前快照状态）。
      try {
        this.#statusNotifier?.notifyBatch(
          propagated.skipped.map((id) => {
            const upstream = dag.tasks.find((t) => t.id === id)
            return {
              taskId: id,
              dagId,
              sessionId: upstream?.session_id ?? task.session_id,
              subject: upstream?.description.split('\n')[0]?.trim() || id,
              from: (preStatuses.get(id) ?? 'WAITING') as TaskStatus,
              to: 'SKIPPED' as TaskStatus,
              actor: 'user' as const,
              source: 'ui_cancel',
            }
          }),
        )
        for (const id of propagated.skipped) {
          // 注意：WAITING/BLOCKED→SKIPPED 属派生规则（AC-TASK-003，不入 32 行矩阵），
          // AC-TASK-002 下审计会拒绝——逐条容错跳过，通知已在上方发出。
          try {
            await this.#audit?.record({
              type: 'task.status_changed',
              task_id: id,
              from: (preStatuses.get(id) ?? 'WAITING') as TaskStatus,
              to: 'SKIPPED',
              by: 'user',
            })
          } catch {
            // 派生转移不被审计（AC-TASK-002）。
          }
        }
      } catch {
        // 通知/审计失败不影响取消本身。
      }
    }
    const after = this.#withStatuses(next, propagated.skipped)
    await this.persistence.tasks.run((db) => {
      db.prepare(`UPDATE dags SET status = ?, updated_at = ? WHERE dag_id = ?`).run(
        toDagStatus(after.tasks),
        now,
        dagId,
      )
    })
    return { ...after, status: toDagStatus(after.tasks) }
  }

  #withStatus(dag: TaskDag, taskId: string, status: TaskStatus): TaskDag {
    return {
      ...dag,
      tasks: dag.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)),
    }
  }

  #withStatuses(dag: TaskDag, skipped: string[]): TaskDag {
    const set = new Set(skipped)
    return {
      ...dag,
      tasks: dag.tasks.map((t) => (set.has(t.id) ? { ...t, status: 'SKIPPED' as const } : t)),
    }
  }
}
