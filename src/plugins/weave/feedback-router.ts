import type { WeaveDatabase } from './persistence/weave-database.js'
import type { SessionTracker } from './session-tracker.js'
import { TaskStateMachine } from './state/task-state-machine.js'
import type { TaskRecord, TaskStatus } from './state/types.js'
import { WeaveError } from './state/weave-error.js'

/**
 * P0-FEEDBACK-008 —— FeedbackRouter：保温期反馈路由（TDD 1.5.6 + 2.1.5 #10-#17）。
 *
 * 职责：
 * - `enterAwaitingFeedback`：任务完成（#10 COMPLETED→AWAITING_FEEDBACK），
 *   feedback_expires_at = now + feedback_timeout_seconds（默认 1800s）；
 * - `route`：反馈意图识别（accept / revise / cancel）+ 对应状态流转；
 * - `accept`（#12）：AWAITING_FEEDBACK→CLOSED，clearRevision，写 closed_at；
 * - `revise`（#11）：AWAITING_FEEDBACK→REVISION_RUNNING，revision_count+1
 *   （上限 max_revisions，默认 5），SessionTracker.recordRevision，保温期挂起；
 * - `cancel`（#13）：AWAITING_FEEDBACK→CANCELLED（终态，参与失败传播）；
 * - `reopen`（#17）：CLOSED→AWAITING_FEEDBACK（reopen_window_seconds 默认 86400s 内），
 *   reopen_count+1，保温期重置，修订上下文保留；
 * - `closeExpired`：保温期超时批量关闭（#12 timeout 分支）。
 *
 * 意图识别（TDD 1.5.6 表格）：
 * - accept: 可以 / 确认 / 就这样 / 没问题 / OK / ok
 * - revise: 不对 / 改成 / 修改 / 重新 / 换
 * - cancel: 取消 / 算了 / 不做了
 * 边界说明（相对文档修订）：原表正则使用 `\b`，对纯中文输入（如"确认"、"改成手机号验证码"）
 * 因 \b 的 ASCII 词边界语义永远不命中；本实现按"关键词前缀"匹配（CJK 无词边界），
 * 同时保证"确认得了/没问题啊"等带尾缀输入仍可识别，语义与 FDD F-06 意图识别一致。
 */

export interface FeedbackConfig {
  /** 保温期秒数（默认 1800）。 */
  feedback_timeout_seconds: number
  /** 最大修订次数（默认 5）。 */
  max_revisions: number
  /** reopen 窗口秒数（默认 86400 = 24h）。 */
  reopen_window_seconds: number
}

export const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  feedback_timeout_seconds: 1800,
  max_revisions: 5,
  reopen_window_seconds: 86400,
}

export type FeedbackIntent = 'accept' | 'revise' | 'cancel'

export interface FeedbackRouterOptions {
  /** tasks.db：任务状态/修订计数/保温期截止时间。 */
  tasks: WeaveDatabase
  /** feedback.db：feedback_routes 路由记录。 */
  feedback: WeaveDatabase
  /** 修订上下文记录（TDD 1.5.5）。 */
  sessionTracker: SessionTracker
  /** 缺省值覆盖（行级缺失时使用）。 */
  config?: Partial<FeedbackConfig>
  /** 可注入时钟（测试用），默认 Date.now。 */
  clock?: () => Date
}

interface FeedbackRouteRow {
  task_id: string
  executor_id: string
  revision_count: number
  status: string | null
  last_completed_at: string | null
  closed_at: string | null
  reopen_count: number
  user_feedback: string
  previous_result: string | null
}

/** 意图识别（前缀匹配；null = 无法识别）。 */
export function recognizeIntent(rawFeedback: string): FeedbackIntent | null {
  const text = rawFeedback.trim()
  if (/^(可以|确认|就这样|没问题|OK|ok)/.test(text)) return 'accept'
  if (/^(不对|改成|修改|重新|换)/.test(text)) return 'revise'
  if (/^(取消|算了|不做了)/.test(text)) return 'cancel'
  return null
}

export class FeedbackRouter {
  readonly #tasks: WeaveDatabase
  readonly #feedback: WeaveDatabase
  readonly #sessionTracker: SessionTracker
  readonly #config: FeedbackConfig
  readonly #clock: () => Date

  constructor(options: FeedbackRouterOptions) {
    this.#tasks = options.tasks
    this.#feedback = options.feedback
    this.#sessionTracker = options.sessionTracker
    this.#config = { ...DEFAULT_FEEDBACK_CONFIG, ...options.config }
    this.#clock = options.clock ?? (() => new Date())
  }

  /**
   * #10：任务完成后进入保温期（自动调用点：Orchestrator 委托完成路径）。
   * 校验任务当前为 COMPLETED；设置 feedback_expires_at；upsert feedback_routes。
   */
  async enterAwaitingFeedback(taskId: string): Promise<TaskRecord> {
    const task = await this.#loadTask(taskId)
    void TaskStateMachine.transition(task.status as TaskStatus, 'AWAITING_FEEDBACK') // 非法转移抛错（AC-TASK-002）
    const now = this.#clock()
    const expires = this.#addSeconds(now, this.#timeoutOf(task))
    await this.#saveTask(task, {
      status: 'AWAITING_FEEDBACK',
      feedback_expires_at: expires,
      revision_count: task.revision_count,
    })
    await this.#upsertRoute(taskId, {
      executor_id: task.executor ?? task.assigned_agent ?? 'unknown',
      status: 'AWAITING_FEEDBACK',
      last_completed_at: this.#iso(now),
      previous_result: task.result,
    })
    return this.#loadTask(taskId)
  }

  /** 识别意图并分发：accept→accept()，revise→revise()，cancel→cancel()。 */
  async route(taskId: string, rawFeedback: string): Promise<{ intent: FeedbackIntent; task: TaskRecord }> {
    const intent = recognizeIntent(rawFeedback)
    if (intent === null) {
      throw new WeaveError('invalid_status_transition', `无法识别的反馈意图: ${rawFeedback.trim()}`)
    }
    const task =
      intent === 'accept'
        ? await this.accept(taskId)
        : intent === 'revise'
          ? await this.revise(taskId, rawFeedback)
          : await this.cancel(taskId)
    return { intent, task }
  }

  /** #12 accept：AWAITING_FEEDBACK→CLOSED；clearRevision；写 closed_at。 */
  async accept(taskId: string): Promise<TaskRecord> {
    const task = await this.#loadTask(taskId)
    this.#assertStatus(task, 'AWAITING_FEEDBACK')
    void TaskStateMachine.transition('AWAITING_FEEDBACK', 'CLOSED')
    await this.#sessionTracker.clearRevision(taskId)
    await this.#saveTask(task, { status: 'CLOSED', feedback_expires_at: null, revision_count: task.revision_count })
    await this.#patchRoute(taskId, { status: 'CLOSED', closed_at: this.#iso(this.#clock()) })
    return this.#loadTask(taskId)
  }

  /** #11 revise：AWAITING_FEEDBACK→REVISION_RUNNING；次数+1；recordRevision。 */
  async revise(taskId: string, feedback: string): Promise<TaskRecord> {
    const task = await this.#loadTask(taskId)
    this.#assertStatus(task, 'AWAITING_FEEDBACK')
    const maxRevisions = task.max_revisions > 0 ? task.max_revisions : this.#config.max_revisions
    if (task.revision_count >= maxRevisions) {
      throw new WeaveError(
        'invalid_status_transition',
        `已达最大修订次数 ${maxRevisions}，拒绝再次修订`,
        { taskId, revision_count: task.revision_count, max_revisions: maxRevisions },
      )
    }
    void TaskStateMachine.transition('AWAITING_FEEDBACK', 'REVISION_RUNNING')
    const nextCount = task.revision_count + 1
    await this.#sessionTracker.recordRevision(taskId, feedback, task.result)
    await this.#saveTask(task, {
      status: 'REVISION_RUNNING',
      feedback_expires_at: null,
      revision_count: nextCount,
    })
    await this.#patchRoute(taskId, { status: 'REVISION_RUNNING', revision_count: nextCount })
    return this.#loadTask(taskId)
  }

  /** #13 cancel：AWAITING_FEEDBACK→CANCELLED（终态；修订上下文保留以便 retry #29）。 */
  async cancel(taskId: string): Promise<TaskRecord> {
    const task = await this.#loadTask(taskId)
    this.#assertStatus(task, 'AWAITING_FEEDBACK')
    void TaskStateMachine.transition('AWAITING_FEEDBACK', 'CANCELLED')
    await this.#saveTask(task, { status: 'CANCELLED', feedback_expires_at: null, revision_count: task.revision_count })
    await this.#patchRoute(taskId, { status: 'CANCELLED' })
    return this.#loadTask(taskId)
  }

  /**
   * #17 reopen：CLOSED→AWAITING_FEEDBACK。
   * 仅 `reopen_window_seconds`（默认 86400s / 24h）内允许；reopen_count+1；保温期重置；
   * 修订上下文（previous_result / user_feedback）与路由历史保留。
   */
  async reopen(taskId: string): Promise<TaskRecord> {
    const task = await this.#loadTask(taskId)
    this.#assertStatus(task, 'CLOSED')
    const route = await this.#getRoute(taskId)
    const closedAtRaw = route?.closed_at ?? task.updated_at
    if (closedAtRaw == null) {
      throw new WeaveError('invalid_status_transition', '缺少关闭时间，无法判断 reopen 窗口', { taskId })
    }
    const closedAtMs = Date.parse(closedAtRaw)
    const now = this.#clock()
    const windowMs = this.#config.reopen_window_seconds * 1000
    if (now.getTime() - closedAtMs > windowMs) {
      throw new WeaveError(
        'invalid_status_transition',
        `已超出 reopen 窗口（${this.#config.reopen_window_seconds}s），无法重新打开`,
        { taskId, closed_at: closedAtRaw, reopen_window_seconds: this.#config.reopen_window_seconds },
      )
    }
    void TaskStateMachine.transition('CLOSED', 'AWAITING_FEEDBACK')
    const expires = this.#addSeconds(now, this.#timeoutOf(task))
    await this.#saveTask(task, { status: 'AWAITING_FEEDBACK', feedback_expires_at: expires, revision_count: task.revision_count })
    await this.#patchRoute(taskId, {
      status: 'AWAITING_FEEDBACK',
      closed_at: null,
      reopen_count: (route?.reopen_count ?? 0) + 1,
    })
    return this.#loadTask(taskId)
  }

  /**
   * #12 timeout 分支：批量关闭保温期已超时的任务。
   * @returns 本次关闭的任务 id 列表。
   */
  async closeExpired(now: Date = this.#clock()): Promise<string[]> {
    const nowMs = now.getTime()
    const rows = await this.#tasks.run((raw) => {
      return raw
        .prepare("SELECT id FROM tasks WHERE status = 'AWAITING_FEEDBACK' AND feedback_expires_at IS NOT NULL")
        .all() as { id: string }[]
    })
    const closed: string[] = []
    for (const { id } of rows) {
      const task = await this.#loadTask(id)
      const expiresMs = task.feedback_expires_at ? Date.parse(task.feedback_expires_at) : Infinity
      if (expiresMs > nowMs) continue
      void TaskStateMachine.transition('AWAITING_FEEDBACK', 'CLOSED')
      await this.#sessionTracker.clearRevision(id)
      await this.#saveTask(task, { status: 'CLOSED', feedback_expires_at: null, revision_count: task.revision_count })
      await this.#patchRoute(id, { status: 'CLOSED', closed_at: this.#iso(now) })
      closed.push(id)
    }
    return closed
  }

  /* ---------------------------------- 内部 ---------------------------------- */

  async #loadTask(taskId: string): Promise<TaskRecord> {
    const row = await this.#tasks.run((raw) => {
      return raw.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRecord | undefined
    })
    if (!row) {
      throw new WeaveError('task_not_found', `任务不存在: ${taskId}`, { taskId })
    }
    return row
  }

  async #saveTask(
    task: TaskRecord,
    patch: { status: TaskStatus; feedback_expires_at: string | null; revision_count: number },
  ): Promise<void> {
    await this.#tasks.run((raw) => {
      raw
        .prepare(
          `UPDATE tasks
           SET status = ?, revision_count = ?, feedback_expires_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(patch.status, patch.revision_count, patch.feedback_expires_at, this.#iso(this.#clock()), task.id)
    })
  }

  /** 反馈路由行：INSERT 或按 task_id 更新（保留 reopen_count 与用户反馈历史）。 */
  async #upsertRoute(
    taskId: string,
    fields: { executor_id: string; status: string; last_completed_at: string; previous_result: string | null },
  ): Promise<void> {
    await this.#feedback.run((raw) => {
      raw
        .prepare(
          `INSERT INTO feedback_routes (task_id, executor_id, revision_count, status, last_completed_at, closed_at, reopen_count, user_feedback, previous_result)
           VALUES (?, ?, 0, ?, ?, NULL, 0, '[]', ?)
           ON CONFLICT(task_id) DO UPDATE SET
             status = excluded.status,
             last_completed_at = excluded.last_completed_at,
             previous_result = COALESCE(excluded.previous_result, feedback_routes.previous_result),
             closed_at = NULL
           `,
        )
        .run(taskId, fields.executor_id, fields.status, fields.last_completed_at, fields.previous_result)
    })
  }

  /** 局部更新路由行（accept / revise / cancel / reopen / closeExpired）。 */
  async #patchRoute(
    taskId: string,
    patch: { status: string; closed_at?: string | null; revision_count?: number; reopen_count?: number },
  ): Promise<void> {
    await this.#feedback.run((raw) => {
      const sets: string[] = []
      const values: (string | number | null)[] = []
      sets.push('status = ?')
      values.push(patch.status)
      if (patch.closed_at !== undefined) {
        sets.push('closed_at = ?')
        values.push(patch.closed_at)
      }
      if (patch.revision_count !== undefined) {
        sets.push('revision_count = ?')
        values.push(patch.revision_count)
      }
      if (patch.reopen_count !== undefined) {
        sets.push('reopen_count = ?')
        values.push(patch.reopen_count)
      }
      values.push(taskId)
      raw.prepare(`UPDATE feedback_routes SET ${sets.join(', ')} WHERE task_id = ?`).run(...values)
    })
  }

  async #getRoute(taskId: string): Promise<FeedbackRouteRow | undefined> {
    return this.#feedback.run((raw) => {
      return raw.prepare('SELECT * FROM feedback_routes WHERE task_id = ?').get(taskId) as
        | FeedbackRouteRow
        | undefined
    })
  }

  #assertStatus(task: TaskRecord, expected: TaskStatus): void {
    if (task.status !== expected) {
      throw new WeaveError(
        'invalid_status_transition',
        `任务 ${task.id} 当前状态为 ${task.status}，不能执行该反馈动作（需 ${expected}）`,
        { taskId: task.id, status: task.status, expected },
      )
    }
  }

  #timeoutOf(task: TaskRecord): number {
    return task.feedback_timeout_seconds > 0 ? task.feedback_timeout_seconds : this.#config.feedback_timeout_seconds
  }

  #iso(date: Date): string {
    return date.toISOString()
  }

  #addSeconds(date: Date, seconds: number): string {
    return new Date(date.getTime() + seconds * 1000).toISOString()
  }
}
