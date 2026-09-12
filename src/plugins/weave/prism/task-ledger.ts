import type { PrismGateway } from './gateway.js'
import type { TaskRecord, TaskStatus } from '../state/types.js'

/**
 * Prism 任务台账镜像（P3）：weave 仍是 live 调度状态的唯一真相，
 * 结算/状态变更**事后回报** prism 台账（被动记录，prism 不执行不调度）。
 *
 * 镜像语义：
 * - DAG 派发时 registerDag 一次性登记（不触发 prism 执行）；
 * - 状态变更经 TaskStatusNotifier.onChange 逐条 report（fire-and-forget）；
 * - prism 不可用/重复登记/状态域差异一律只告警——镜像失败绝不影响 weave 调度主链路。
 */

/** 登记所需的 DAG 元信息（dags 表行 + 会话）。 */
export interface PrismTaskRegisterMeta {
  dag_id: string
  session_id: string
  team_id: string
  project_id: string
  version: string
  difficulty: string
}

/** 状态回报（TaskStatusChange 的最小投影；prism 状态域是 weave 的超集，直接透传）。 */
export interface PrismTaskReportChange {
  taskId: string
  from?: TaskStatus
  to: TaskStatus
  actor: string
}

/** DAG 登记 → prism DagRegisterInput 载荷（纯函数）。 */
export function prismRegisterPayload(meta: PrismTaskRegisterMeta, tasks: TaskRecord[]): Record<string, unknown> {
  return {
    dag_id: meta.dag_id,
    session_id: meta.session_id,
    team_id: meta.team_id,
    project_id: meta.project_id,
    version: meta.version,
    difficulty: meta.difficulty,
    tasks: tasks.map((task) => ({
      id: task.id,
      description: task.description,
      dependencies: task.dependencies ?? [],
      ...(task.assigned_agent ? { assigned_agent: task.assigned_agent } : {}),
      ...(task.executor ? { executor: task.executor } : {}),
    })),
  }
}

export interface TaskLedgerMirrorOptions {
  gateway: PrismGateway
  log?: Pick<Console, 'warn'>
}

export class TaskLedgerMirror {
  readonly #gateway: PrismGateway
  readonly #log: Pick<Console, 'warn'>

  constructor(options: TaskLedgerMirrorOptions) {
    this.#gateway = options.gateway
    this.#log = options.log ?? console
  }

  /** DAG 登记（fire-and-forget）。 */
  registerDag(meta: PrismTaskRegisterMeta, tasks: TaskRecord[]): void {
    const payload = prismRegisterPayload(meta, tasks)
    void this.#gateway.taskRegister(payload).catch((error) => {
      this.#log.warn(`[dsh-weave] prism 任务台账登记失败（不影响调度）: ${meta.dag_id}:`, error)
    })
  }

  /** 状态回报（fire-and-forget）。 */
  report(change: PrismTaskReportChange): void {
    void this.#gateway
      .taskReport({
        task_id: change.taskId,
        to_status: change.to,
        by: change.actor,
        ...(change.from !== undefined ? { from_status: change.from } : {}),
      })
      .catch((error) => {
        this.#log.warn(`[dsh-weave] prism 任务台账回报失败（不影响调度）: ${change.taskId} → ${change.to}:`, error)
      })
  }
}
