import type { TaskStatus } from '../state/types.js'

/**
 * 任务状态变更通知单出口（doc/05 §6.4 P1-D）。
 *
 * 所有任务状态变更点（调度器旁路/治理动作/反馈路由/恢复）统一经本 notifier 发电，
 * 与 `task.status_changed` 审计同位置同清单——接线点写通知时同步补齐审计。
 *
 * 噪声控制三件套：
 * - 回声抑制：actor=captain/user 的动作默认不通知（echoSelfActions=false，发起者
 *   已知结果，回声即噪声）；
 * - 批量合并：SKIPPED 传播 / closeExpired 等批量变更走 notifyBatch，按 DAG 合并为
 *   一条汇总（每项一行，最多 10 行，超出折叠计数）；
 * - 整体吞错：通知失败不影响治理动作本身（观察者哲学，与 #emitExecutorEvent 一致）。
 *
 * 与 P1-B 实时流的关系：共用 notifySession 通道但不共用节流器——状态变更是离散
 * 低频语义事件（用户决策依据），节流会吞语义。
 */

export type TaskStatusActor = 'scheduler' | 'captain' | 'user' | 'recovery' | 'feedback'

export interface TaskStatusChange {
  taskId: string
  dagId: string
  /** 通知路由键：task 行自带 session_id，写点上下文直接取，零查表。 */
  sessionId: string
  /** 任务短标题；缺省回退 taskId。 */
  subject?: string
  from: TaskStatus
  to: TaskStatus
  actor: TaskStatusActor
  /** 触发来源标识：'task_cancel' | 'task_retry' | 'feedback_revise' | 'close_expired' | … */
  source: string
}

export interface TaskStatusNotifierOptions {
  /** 通知出口（生产绑 notifySession 包装；测试注入收集器）。 */
  notify: (sessionId: string, text: string) => void
  /** 回声抑制开关：true 时 captain/user 动作也通知；默认 false（不回声）。 */
  echoSelfActions?: boolean
}

/** 批量汇总单条消息最多展开的变更行数，超出折叠为计数。 */
const BATCH_MAX_LINES = 10

const SELF_ACTORS: ReadonlySet<TaskStatusActor> = new Set(['captain', 'user'])

export class TaskStatusNotifier {
  readonly #notify: (sessionId: string, text: string) => void
  readonly #echoSelfActions: boolean

  constructor(options: TaskStatusNotifierOptions) {
    this.#notify = options.notify
    this.#echoSelfActions = options.echoSelfActions ?? false
  }

  /** 单条状态变更通知；文案统一，异常吞掉。 */
  notify(change: TaskStatusChange): void {
    try {
      if (this.#isSuppressed(change)) return
      this.#notify(change.sessionId, TaskStatusNotifier.formatChange(change))
    } catch {
      // 通知失败不影响治理动作本身。
    }
  }

  /**
   * 批量状态变更通知（SKIPPED 传播 / closeExpired 等）：先过滤回声，再按 DAG
   * 分组合并为一条汇总；单组超过 10 行折叠计数。异常吞掉。
   */
  notifyBatch(changes: TaskStatusChange[]): void {
    try {
      const visible = changes.filter((change) => !this.#isSuppressed(change))
      if (visible.length === 0) return
      const byDag = new Map<string, TaskStatusChange[]>()
      for (const change of visible) {
        const list = byDag.get(change.dagId) ?? []
        list.push(change)
        byDag.set(change.dagId, list)
      }
      for (const [dagId, list] of byDag) {
        // 同 DAG 的任务同属一个会话，取首项 sessionId 路由。
        this.#notify(list[0]?.sessionId ?? '', TaskStatusNotifier.formatBatch(dagId, list))
      }
    } catch {
      // 通知失败不影响治理动作本身。
    }
  }

  #isSuppressed(change: TaskStatusChange): boolean {
    return !this.#echoSelfActions && SELF_ACTORS.has(change.actor)
  }

  /** 单条文案：`[weave] 任务「{subject|taskId}」{from} → {to}（{source}）` */
  static formatChange(change: TaskStatusChange): string {
    const label = change.subject !== undefined && change.subject.trim() !== '' ? change.subject.trim() : change.taskId
    return `[weave] 任务「${label}」${change.from} → ${change.to}（${change.source}）`
  }

  /**
   * 批量文案：`[weave] 任务图 {dagId} 状态变更 {n} 项：\n` + 每项一行（最多 10 行，
   * 超出折叠为 `…（其余 N 项折叠）`）。
   */
  static formatBatch(dagId: string, changes: TaskStatusChange[]): string {
    const lines = changes.map((change) => {
      const label = change.subject !== undefined && change.subject.trim() !== '' ? change.subject.trim() : change.taskId
      return `「${label}」${change.from} → ${change.to}（${change.source}）`
    })
    const shown = lines.slice(0, BATCH_MAX_LINES)
    if (lines.length > BATCH_MAX_LINES) {
      shown.push(`…（其余 ${lines.length - BATCH_MAX_LINES} 项折叠）`)
    }
    return `[weave] 任务图 ${dagId} 状态变更 ${changes.length} 项：\n${shown.join('\n')}`
  }
}
