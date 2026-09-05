import { existsSync } from 'node:fs'
import type { SubagentTaskOutput } from './delegation-service.js'
import { GraphService } from '../graph/graph-service.js'
import type { RoleConfig, TeamConfig } from '../team/team-manager.js'
import type { WeavePersistence } from '../persistence/persistence.js'
import { toDagStatus } from '../dag/repository.js'
import { TaskStateMachine } from '../state/task-state-machine.js'
import { newAttemptToken, TASK_STALE_REVISION, type AttemptGuard } from '../state/attempt-token.js'
import type { TaskDag, TaskRecord, TaskStatus } from '../state/types.js'
import { WeaveError } from '../state/weave-error.js'
import { parseWriteScopes, scopeSetsOverlap } from '../state/write-scope.js'
import type { NoticeSessionLike } from './session-delegation.js'
import type { TaskStatusNotifier } from './task-status-notifier.js'
import { DagActivity, type DagWaitResult } from './activity-waiter.js'
import type { AuditLog } from '../audit/audit-log.js'

/**
 * 队长调度器（会话即团队·队长调度模式）：
 * - weave_plan_tasks 落库 DAG 后由本模块按依赖自动调度成员执行；唯一执行出口
 *   仍是 DelegationService.executeTask → ctx.subagents.start（ADR 红线不变）；
 * - 状态全程回写 tasks/dags（修复"执行的内存态 vs 落库的不执行"两条轨割裂）；
 * - 任务开始/完成/失败与整体汇总经回调写入当前会话 durable log，队长模型据此汇总答复；
 * - 一个团队角色同一时刻只执行一个任务（会话内固定单并发，跨 DAG 共占额度，
 *   不读 max_concurrent_tasks 配置）；失败按角色
 *   fallback 重试一次；失败/取消终态经 TaskStateMachine.propagateFailure 向下游传播 SKIPPED。
 */

/**
 * 调度器 → 委托执行的上下文（DelegationService.TaskContext 的调度侧视面）。
 */
export interface SchedulerDelegationContext {
  parentAgent?: unknown
  /** 宿主会话 id（doc/05 §6.2 P1-B）：执行器事件回灌按它路由，避免发进子代理会话。 */
  sessionId?: string
  upstreamOutputs?: Array<{ label: string; output: string }>
  outputRequirements?: string
  /**
   * 槽位获得回调（假并行修复）：DelegationService 在任务实际开始执行前、
   * provider.start 前触发；调度器在此写 RUNNING + 发开始通知（真·RUNNING 时点）。
   */
  onAcquired?: () => void | Promise<void>
}

/** DelegationService 的最小视面（测试可注入替身）。 */
export interface SchedulerDelegationLike {
  /**
   * 槽位回调能力声明（假并行修复）：true 时调度器把「写 RUNNING + 开始通知」
   * 后移到 context.onAcquired（排队期任务保持 WAITING）；未声明的历史实现
   * 保持派发点直写 RUNNING 的现状（向后兼容）。
   */
  readonly supportsSlotAcquiredHook?: boolean
  executeTask(
    task: TaskRecord,
    role: RoleConfig,
    team: TeamConfig,
    context: SchedulerDelegationContext,
    cancelSignal: AbortSignal,
  ): Promise<SubagentTaskOutput>
}

export type SchedulerNotifyFn = (sessionId: string, text: string, session?: NoticeSessionLike) => void

export interface WeaveSchedulerOptions {
  delegation: SchedulerDelegationLike
  persistence: WeavePersistence
  /** 团队加载器（start 时快照团队配置）。 */
  loadTeam: (teamId: string) => TeamConfig
  /** 会话通知通道（生产绑定 session-delegation.notifySession 的安全包装）。 */
  notify: SchedulerNotifyFn
  /** 失败后是否用 fallback_provider/model 重试一次（默认 true）。 */
  retryWithFallback?: boolean
  /** 反思钩子：任务终态文本沉淀入口，返回沉淀条数；异常不阻断调度。 */
  onTaskSettledText?: (params: { task: TaskRecord; role: RoleConfig; team: TeamConfig; text: string; status: 'COMPLETED' | 'FAILED' }) => Promise<number | void>
  /** 任务状态变更通知单出口（doc/05 §6.4 P1-D）：旁路（外部取消/重试）发电；未注入则不发电（向后兼容）。 */
  statusNotifier?: TaskStatusNotifier
  /** 审计（接线点同步补 task.status_changed）；未注入则只通知不审计。 */
  audit?: AuditLog
  /** 知识候选计数：DAG 收敛时候选 >0 则提醒队长审核（未注入则不提醒）。 */
  countKnowledgeCandidates?: () => Promise<number>
  log?: { warn?: (...args: unknown[]) => void }
}

export interface DagStartInput {
  dagId: string
  sessionId: string
  /** 当前会话 Agent：子代理 parent，同时尽量携带 .session 作为通知落点。 */
  parentAgent?: unknown
}

interface DagRunContext {
  dagId: string
  sessionId: string
  team: TeamConfig
  parentAgent: unknown
  settledNotified: boolean
}

export interface MemberRuntimeInfo {
  role_id: string
  task_id: string
  subject: string
  started_at: string
  /**
   * 执行阶段（假并行修复）：queued=已派发但仍在执行器槽排队；running=已拿到槽
   * 真正执行（onAcquired 后翻转）。未声明槽位回调的委托实现恒为 running。
   */
  phase: 'queued' | 'running'
}

const SUCCESS_TERMINALS: ReadonlySet<TaskStatus> = new Set(['COMPLETED', 'CLOSED'])

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'COMPLETED',
  'CLOSED',
  'FAILED',
  'BANNED',
  'LOOP_TERMINATED',
  'INTERRUPTED',
  'CANCELLED',
  'SKIPPED',
])

function outputTextOf(output: SubagentTaskOutput): string {
  return output.output.map((block) => block.text).join('')
}

/** 缺省映射（无 weave 扩展时按 stopReason 推导；errorType 与 TDD 2.4.3 对齐，不外泄枚举原文）。 */
function mappingFallback(output: SubagentTaskOutput): {
  status: 'COMPLETED' | 'CANCELLED' | 'FAILED'
  errorType: string | null
  countBreaker: boolean
} {
  if (output.stopReason === 'completed') return { status: 'COMPLETED', errorType: null, countBreaker: false }
  if (output.stopReason === 'aborted') return { status: 'CANCELLED', errorType: 'aborted', countBreaker: false }
  return { status: 'FAILED', errorType: 'execution_failed', countBreaker: true }
}

export class WeaveScheduler {
  readonly #opts: WeaveSchedulerOptions
  readonly #persistence: WeavePersistence
  /** dagId → 运行上下文（团队快照/通知目标）。 */
  readonly #runs = new Map<string, DagRunContext>()
  /** taskId → AbortController（运行中任务；UI/MCP 取消联动）。 */
  readonly #controllers = new Map<string, AbortController>()
  /** taskId → 活动心跳定时器：避免子代理活跃但任务 updated_at 不更新导致误判卡死。 */
  readonly #heartbeats = new Map<string, ReturnType<typeof setInterval>>()
  /** `${sessionId}\u0000${roleId}` → 运行时占用（并发上限仲裁 + 成员状态展示）。 */
  readonly #activeByRole = new Map<string, MemberRuntimeInfo>()
  /** dagId → 泵序列化链（避免同一 DAG 并发泵）。 */
  readonly #chains = new Map<string, Promise<void>>()
  /** taskId → 派发守卫：同一任务未 settle 前禁止重复 start。 */
  readonly #dispatchGuards = new Map<string, { settled: boolean }>()
  /** DAG 变更一次性等待者（waitForChange 数据面，notify-only 不缓存历史）。 */
  readonly #activity = new DagActivity()

  constructor(options: WeaveSchedulerOptions) {
    this.#opts = options
    this.#persistence = options.persistence
  }

  /* ------------------------------- 对外入口 ------------------------------- */

  /**
   * 启动一个 DAG 的调度（weave_plan_tasks 成功后调用）。
   * 团队在此刻做快照（loadTeam）；重复调用幂等——已有运行上下文则继续泵。
   * 返回后调度在后台进行；进度经 notify 回灌会话。
   */
  async start(input: DagStartInput): Promise<void> {
    await this.#ensureRun(input.dagId)
    // 重入：刷新通知面（同一会话续聊时拿到最新 session 对象）。
    const run = this.#runs.get(input.dagId)!
    if (input.parentAgent !== undefined) run.parentAgent = input.parentAgent
    await this.#enqueue(input.dagId)
  }

  /**
   * run 上下文冷启动重建（doc/05 §6.5 P1-G G-②）：run 随 DAG 收敛销毁后，治理
   * 入口（取消/重试）按需重建——查 dags.team_id → loadTeam → 建上下文。
   * sessionId 取该组任务行（同组一致，治理入口无显式入参）；parentAgent 未知置
   * undefined（委派父代理可能已销毁），通知经 agentsRegistry 兜底（T31）。
   * DAG 不存在时抛 task_not_found（与 start 语义一致）。
   */
  async #ensureRun(dagId: string): Promise<void> {
    if (this.#runs.has(dagId)) return
    const existing = await this.#persistence.tasks.run((db) => {
      return db.prepare('SELECT team_id FROM dags WHERE dag_id = ?').get(dagId) as
        | { team_id: string }
        | undefined
    })
    if (!existing) {
      throw new WeaveError('task_not_found', `DAG 不存在: ${dagId}`, { dagId })
    }
    const team = this.#opts.loadTeam(existing.team_id)
    const sessionRow = await this.#persistence.tasks.run((db) => {
      return db.prepare('SELECT session_id FROM tasks WHERE dag_id = ? LIMIT 1').get(dagId) as
        | { session_id: string }
        | undefined
    })
    this.#runs.set(dagId, {
      dagId,
      sessionId: sessionRow?.session_id ?? '',
      team,
      parentAgent: undefined,
      settledNotified: false,
    })
  }

  /** UI/MCP 取消联动：中止运行中的子代理并重泵该 DAG 以收敛状态。 */
  async onExternalCancel(taskId: string): Promise<void> {
    this.#controllers.get(taskId)?.abort()
    const dagId = await this.#dagIdOf(taskId)
    if (dagId) {
      // G-②（doc/05 §6.5）：已收敛组 run 已销毁 → 冷启动重建，重泵不再空转。
      await this.#ensureRun(dagId)
      // 接线点 1（doc/05 §6.4）：用户发起取消 → 发电 + 审计（from 取库内当前状态；
      // 已是 CANCELLED 的重复调用不重复发电）。运行中任务的"已取消"收敛通知由
      // 主链路既有路径负责，此处为旁路单出口。
      try {
        const dag = await this.loadDag(dagId)
        const task = dag.tasks.find((item) => item.id === taskId)
        if (task && task.status !== 'CANCELLED') {
          this.#opts.statusNotifier?.notify({
            taskId,
            dagId,
            sessionId: task.session_id,
            subject: subjectLabel(task),
            from: task.status,
            to: 'CANCELLED',
            actor: 'user',
            source: 'task_cancel',
          })
          await this.#opts.audit?.record({
            type: 'task.status_changed',
            task_id: taskId,
            from: task.status,
            to: 'CANCELLED',
            by: 'user',
          })
        }
      } catch (error) {
        this.#opts.log?.warn?.('[dsh-weave] external cancel notify failed:', error)
      }
      await this.#enqueue(dagId)
    }
  }

  /**
   * UI/MCP 重试联动（task_retry 已把状态改为 WAITING）：
   * 恢复该任务下游被 SKIPPED 的成员任务并重新泵 DAG。
   * G-②（doc/05 §6.5）：run 随收敛销毁后此入口曾静默早退（已结束组治理失效）——
   * 现冷启动重建 run 再联动，已结束组任务重试可恢复执行。
   */
  async onExternalRetry(taskId: string): Promise<void> {
    const dagId = await this.#dagIdOf(taskId)
    if (!dagId) return
    await this.#ensureRun(dagId)
    try {
      const dag = await this.loadDag(dagId)
      const reactivated = TaskStateMachine.reactivateSkipped(dag, taskId)
      if (reactivated.reactivated.length > 0) {
        const statusById = new Map(dag.tasks.map((item) => [item.id, item.status]))
        const now = new Date().toISOString()
        await this.#persistence.tasks.run((db) => {
          const stmt = db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
          for (const id of reactivated.reactivated) {
            const status = statusById.get(id)
            if (status !== undefined) stmt.run(status, now, id)
          }
        })
        // 接线点 2（doc/05 §6.4）：恢复批量发电（SKIPPED → WAITING）+ 审计。
        const byId = new Map(dag.tasks.map((item) => [item.id, item]))
        this.#opts.statusNotifier?.notifyBatch(
          reactivated.reactivated.map((id) => ({
            taskId: id,
            dagId,
            sessionId: byId.get(id)?.session_id ?? '',
            subject: byId.get(id) ? subjectLabel(byId.get(id)!) : id,
            from: 'SKIPPED' as TaskStatus,
            to: (statusById.get(id) ?? 'WAITING') as TaskStatus,
            actor: 'user' as const,
            source: 'task_retry',
          })),
        )
        for (const id of reactivated.reactivated) {
          // 注意：SKIPPED→BLOCKED/WAITING 属派生规则（AC-TASK-004，不入 32 行矩阵），
          // AC-TASK-002 下审计会拒绝该转移——逐条容错跳过，矩阵内转移正常入账。
          try {
            await this.#opts.audit?.record({
              type: 'task.status_changed',
              task_id: id,
              from: 'SKIPPED',
              to: (statusById.get(id) ?? 'WAITING') as TaskStatus,
              by: 'user',
            })
          } catch {
            // 派生转移不被审计（AC-TASK-002）；通知已在上方发出，不回滚。
          }
        }
      }
    } catch (error) {
      this.#opts.log?.warn?.('[dsh-weave] resume reactivate failed:', error)
    }
    await this.#enqueue(dagId)
  }

  /**
   * 队长值守等待：阻塞到该 DAG 的下一条状态变更边沿（或超时/中止）。
   * 无在途任务（无 RUNNING/排队中的成员占用、无派发窗口）时等待毫无意义，
   * 立即返回 noProgress=true 让调用方自行复查状态；有在途任务则注册一次性
   * 等待者，#updateTask/#afterTaskSettled 的任一状态写入都会 notify 唤醒。
   * 边沿不重放：注册前的变更由返回后的状态复查兜底（与官方 activity.ts 同语义）。
   */
  async waitForChange(dagId: string, timeoutMs: number, signal: AbortSignal): Promise<DagWaitResult & { noProgress: boolean }> {
    const dag = await this.loadDag(dagId)
    const inFlight = new Set<string>([...this.#controllers.keys(), ...this.#dispatchGuards.keys()])
    for (const info of this.#activeByRole.values()) inFlight.add(info.task_id)
    const hasActive = dag.tasks.some(
      (task) => task.status === 'RUNNING' || inFlight.has(task.id),
    )
    if (!hasActive) return { timedOut: false, noProgress: true }
    const result = await this.#activity.wait(dagId, timeoutMs, signal)
    return { ...result, noProgress: false }
  }

  /** 会话内各角色的实时占用（session/status RPC 数据源）。 */
  memberRuntime(sessionId: string): MemberRuntimeInfo[] {
    const result: MemberRuntimeInfo[] = []
    for (const [key, info] of this.#activeByRole.entries()) {
      if (key.split('\u0000')[0] === sessionId) result.push(info)
    }
    return result.sort((a, b) => a.started_at.localeCompare(b.started_at))
  }

  /** 中止本地全部运行（插件卸载兜底）；已落库的任务状态不受影响。 */
  dispose(): void {
    for (const controller of this.#controllers.values()) controller.abort()
    this.#controllers.clear()
    for (const timer of this.#heartbeats.values()) clearInterval(timer)
    this.#heartbeats.clear()
    this.#runs.clear()
    this.#activeByRole.clear()
    this.#activity.close()
  }

  /* ------------------------------ 持久化读写 ------------------------------ */

  loadDag(dagId: string): Promise<TaskDag> {
    return this.#persistence.tasks.run((db) => {
      const dagRow = db.prepare('SELECT * FROM dags WHERE dag_id = ?').get(dagId) as Record<string, string> | undefined
      if (!dagRow) throw new WeaveError('task_not_found', `DAG 不存在: ${dagId}`, { dagId })
      const rows = db
        .prepare('SELECT * FROM tasks WHERE dag_id = ? ORDER BY rowid')
        .all(dagId) as unknown as Array<
        Omit<TaskRecord, 'dependencies' | 'skip_override' | 'write_scopes' | 'revision' | 'attempt_token'> & {
          dependencies: string
          skip_override: number
          write_scopes: string | null
          revision: number | null
          attempt_token: string | null
        }
      >
      const edges = db
        .prepare('SELECT from_task_id AS "from", to_task_id AS "to" FROM edges WHERE dag_id = ?')
        .all(dagId) as unknown as TaskDag['edges']
      const tasks: TaskRecord[] = rows.map((row) => ({
        ...row,
        dependencies: safeParseDeps(row.dependencies),
        write_scopes: parseWriteScopes(row.write_scopes),
        // v3 乐观并发列：legacy 行缺列时归一（undefined → 0/NULL），守卫语义不受影响。
        revision: Number(row.revision ?? 0),
        attempt_token: row.attempt_token ?? null,
        skip_override: row.skip_override === 1,
      }))
      return { dag_id: dagId, tasks, edges, status: toDagStatus(tasks) }
    })
  }

  async #dagIdOf(taskId: string): Promise<string | null> {
    const row = await this.#persistence.tasks.run((db) => {
      return db.prepare('SELECT dag_id FROM tasks WHERE id = ?').get(taskId) as { dag_id: string } | undefined
    })
    return row?.dag_id ?? null
  }

  /**
   * 任务写入统一漏斗。`guard` 缺省为调度器内部无主写入（晋升/派发前写），行为不变；
   * attempt 侧回写必须携带 { token, expectedRevision } 双验证（token 匹配 + revision 未过期），
   * 任一不符即拒绝并抛 WeaveError('task_stale_revision')——重派/取消后旧 attempt 的
   * 迟到回写不得覆写新 generation 的状态（参照官方 activateTaskAttempt/invalidateTaskAttempt）。
   */
  async #updateTask(
    taskId: string,
    patch: Partial<Pick<TaskRecord, 'status' | 'result' | 'error_type'>>,
    guard?: AttemptGuard,
  ): Promise<void> {
    const dagId = await this.#persistence.tasks.run((db) => {
      const sets = ['updated_at = ?']
      const params: Array<string | null> = [new Date().toISOString()]
      for (const [field, value] of Object.entries(patch)) {
        sets.push(`${field} = ?`)
        params.push(value === undefined ? null : String(value))
      }
      let sql = `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`
      const tail: Array<string | number> = [taskId]
      if (guard !== undefined) {
        sql += ' AND attempt_token = ? AND revision = ?'
        tail.push(guard.token, guard.expectedRevision)
      }
      const info = db.prepare(sql).run(...params, ...tail)
      if (guard !== undefined && info.changes === 0) {
        const current = db.prepare('SELECT status, attempt_token, revision FROM tasks WHERE id = ?').get(taskId) as
          | { status: TaskStatus; attempt_token: string | null; revision: number | null }
          | undefined
        throw new WeaveError(
          TASK_STALE_REVISION,
          `任务 ${taskId} 回写被拒（attempt 句柄失效或 revision 过期；当前 ${current?.status ?? '不存在'}）`,
          {
            taskId,
            expected: { token: guard.token, revision: guard.expectedRevision },
            current: current ?? null,
          },
        )
      }
      if (guard !== undefined) {
        // 守卫写成功即推进版本号：同 attempt 的并发双写只有携带最新 revision 的一方胜出。
        db.prepare('UPDATE tasks SET revision = revision + 1 WHERE id = ?').run(taskId)
      }
      const row = db.prepare('SELECT dag_id FROM tasks WHERE id = ?').get(taskId) as
        | { dag_id: string }
        | undefined
      return row?.dag_id ?? null
    })
    // 状态变更边沿：唤醒该 DAG 的 waitForChange 等待者（无等待者时零开销）。
    if (dagId) this.#activity.notify(dagId)
  }

  /**
   * claim（→RUNNING）并签发 attempt 句柄（activateTaskAttempt 语义）：单事务读改写——
   * 状态机校验 → 写 RUNNING + 新 token + revision+1。签发即轮换：旧 attempt 的句柄同帧作废。
   * 幂等：已 RUNNING 且持有句柄时返回现有句柄（重入 claim 不换代，恢复/retry 同规则）。
   */
  async #claimTask(taskId: string): Promise<AttemptGuard> {
    return this.#persistence.tasks.run((db) => {
      const row = db.prepare('SELECT status, revision, attempt_token FROM tasks WHERE id = ?').get(taskId) as
        | { status: TaskStatus; revision: number | null; attempt_token: string | null }
        | undefined
      if (!row) throw new WeaveError('task_not_found', `任务不存在: ${taskId}`, { taskId })
      if (row.status === 'RUNNING' && row.attempt_token !== null) {
        return { token: row.attempt_token, expectedRevision: Number(row.revision ?? 0) }
      }
      if (!TaskStateMachine.canTransition(row.status, 'RUNNING')) {
        throw new WeaveError('invalid_status_transition', `任务 ${taskId} 状态 ${row.status} 不可 claim 为 RUNNING`, {
          taskId,
          status: row.status,
        })
      }
      const token = newAttemptToken()
      const revision = Number(row.revision ?? 0) + 1
      db.prepare(
        "UPDATE tasks SET status = 'RUNNING', attempt_token = ?, revision = ?, updated_at = ? WHERE id = ?",
      ).run(token, revision, new Date().toISOString(), taskId)
      return { token, expectedRevision: revision }
    })
  }

  async #persistSkipped(skippedIds: string[]): Promise<void> {
    if (skippedIds.length === 0) return
    const now = new Date().toISOString()
    await this.#persistence.tasks.run((db) => {
      const stmt = db.prepare("UPDATE tasks SET status = 'SKIPPED', updated_at = ? WHERE id = ?")
      for (const id of skippedIds) stmt.run(now, id)
    })
  }

  async #persistDagStatus(dagId: string): Promise<void> {
    await this.#persistence.tasks.run((db) => {
      const rows = db.prepare('SELECT status FROM tasks WHERE dag_id = ?').all(dagId) as { status: TaskStatus }[]
      db.prepare('UPDATE dags SET status = ?, updated_at = ? WHERE dag_id = ?').run(
        toDagStatus(rows.map((row) => ({ status: row.status }) as TaskRecord)),
        new Date().toISOString(),
        dagId,
      )
    })
  }

  /* ------------------------------- 调度主环 ------------------------------- */

  #beginDispatch(taskId: string): boolean {
    const existing = this.#dispatchGuards.get(taskId)
    if (existing !== undefined && !existing.settled) return false
    this.#dispatchGuards.set(taskId, { settled: false })
    return true
  }

  #endDispatch(taskId: string): void {
    this.#dispatchGuards.delete(taskId)
  }


  #enqueue(dagId: string): void {
    const previous = this.#chains.get(dagId) ?? Promise.resolve()
    const next = previous
      .then(() => this.#pump(dagId))
      .catch((error) => {
        this.#opts.log?.warn?.('[dsh-weave] scheduler pump error:', error)
      })
      .then(() => undefined)
    this.#chains.set(dagId, next)
  }

  async #pump(dagId: string): Promise<void> {
    const run = this.#runs.get(dagId)
    if (!run) return
    const dag = await this.loadDag(dagId)
    if (dag.tasks.length === 0) return

    // 全部终态 → 收敛：刷库 + 汇总通知 + 清理运行上下文
    if (dag.tasks.every((task) => TERMINAL_STATUSES.has(task.status))) {
      await this.#persistDagStatus(dagId)
      if (!run.settledNotified) {
        run.settledNotified = true
        this.#notifySummary(run, dag)
        this.#runs.delete(dagId)
        await this.#notifyKnowledgeReview(run)
        // DAG 收敛后自动为交付目录构建代码图谱并回灌主会话（此前图谱只建不用，
        // 主对话完全感知不到）。后台执行，不阻塞收敛链路。
        void this.#notifyGraphBuild(run, dag)
      }
      return
    }

    // 依赖满足度晋升：BLOCKED 且上游全部成功终态 → WAITING（状态机无 BLOCKED→RUNNING 直达）
    const byId0 = new Map(dag.tasks.map((task) => [task.id, task]))
    // 坏依赖图快速失败：edges 指向不存在的任务时该任务永无就绪日（就绪判定恒
    // false），DAG 永不收敛且零日志。判 FAILED(bad_dependency) 并走既有失败
    // 传播链向下游 SKIPPED——把"任务静默卡死"变成可观测的一次性收敛。
    for (const task of dag.tasks) {
      if (TERMINAL_STATUSES.has(task.status)) continue
      if (!task.dependencies.some((dep) => !byId0.has(dep))) continue
      this.#opts.log?.warn?.(
        `[dsh-weave] task ${task.id} 依赖不存在的任务（${task.dependencies.join(',')}），判 FAILED(bad_dependency)`,
      )
      await this.#forceTransition(task, 'FAILED', { error_type: 'bad_dependency' })
      await this.#afterTaskSettled(run, task, 'FAILED')
      return
    }
    const promoted: TaskRecord[] = []
    for (const task of dag.tasks) {
      if (task.status !== 'BLOCKED') continue
      const depsOk = task.dependencies.every((dep) => {
        const depStatus = byId0.get(dep)?.status
        return depStatus !== undefined && SUCCESS_TERMINALS.has(depStatus)
      })
      if (!depsOk) continue
      await this.#updateTask(task.id, { status: 'WAITING' })
      promoted.push(task)
    }
    for (const task of promoted) task.status = 'WAITING'
    // 反馈流任务（AWAITING_FEEDBACK/REVISION_RUNNING）不归调度器管；仅推进 WAITING/BLOCKED。

    // 就绪判定：WAITING 且上游全部成功终态；随后按角色并发上限派发。
    // Phase 4：同批就绪任务按角色 priority 降序，优先派发高优先级角色。
    const byId = new Map(dag.tasks.map((task) => [task.id, task]))
    const readyTasks = dag.tasks
      .filter((task) => task.status === 'WAITING')
      .sort((a, b) => {
        const roleA = run.team.roles.find((role) => role.id === a.assigned_agent)
        const roleB = run.team.roles.find((role) => role.id === b.assigned_agent)
        return (roleB?.priority ?? 0) - (roleA?.priority ?? 0)
      })
    // 写域重叠提醒（advisory，官方 agent-team taskView 同语义）：就绪任务与
    // in-progress 任务写域前缀重叠 → notify 告警，只提醒不阻断派发。
    // in-progress = 库内 RUNNING/REVISION_RUNNING + 角色占用（含排队中）；
    // 本轮已派发任务即时并入集合——同批并行派发的重叠也能被发现。
    // 就绪任务均无写域时零查询（零写域团队零开销）。
    const inProgressScopes: Array<{ taskId: string; scopes: string[] }> = readyTasks.some(
      (task) => task.write_scopes.length > 0,
    )
      ? await this.#inProgressScopes(run.sessionId)
      : []
    for (const task of readyTasks) {
      if (task.status !== 'WAITING') continue
      const depsOk = task.dependencies.every((dep) => {
        const depStatus = byId.get(dep)?.status
        return depStatus !== undefined && SUCCESS_TERMINALS.has(depStatus)
      })
      if (!depsOk) continue

      const role = run.team.roles.find((r) => r.id === task.assigned_agent)
      if (!role) continue
      // 产品约束：一个团队角色同一时刻只执行一个任务（会话内固定单并发，
      // 跨 DAG 共占额度；不读 max_concurrent_tasks 配置）。
      const key = activeKey(run.sessionId, role.id, task.id)
      const rolePrefix = activeRolePrefix(run.sessionId, role.id)
      let roleBusy = false
      for (const existing of this.#activeByRole.keys()) {
        if (existing.startsWith(rolePrefix)) {
          roleBusy = true
          break
        }
      }
      if (roleBusy) continue

      // 写域重叠告警（只提醒不阻断）：与执行中/已派发任务的写域前缀重叠。
      if (task.write_scopes.length > 0) {
        const overlapped = inProgressScopes.filter(
          (other) => other.taskId !== task.id && scopeSetsOverlap(task.write_scopes, other.scopes),
        )
        if (overlapped.length > 0) {
          const others = overlapped.map((other) => other.taskId).join('、')
          const scopes = [...new Set(overlapped.flatMap((other) => other.scopes))].join('、')
          this.#notifySafe(
            run,
            `[weave] ⚠️ 写域重叠提醒：任务「${subjectLabel(task)}」(${task.id}) 与执行中任务 (${others}) 写域重叠 [${scopes}]——仅提醒不阻断，注意并行写入冲突`,
          )
        }
      }

      // 状态机无 BLOCKED→RUNNING 直达：先升 WAITING 再 RUNNING（TDD §2.1.5）。
      // 假并行修复：委托方声明支持槽位回调时，排队期任务保持 WAITING——
      // 真正拿到执行器槽后经 context.onAcquired 才 claim RUNNING；未声明（历史
      // 委托实现/测试替身）保持派发点直写 RUNNING 的现状。
      const acquiredHook = this.#opts.delegation.supportsSlotAcquiredHook === true
      if (!TaskStateMachine.canTransition(task.status, 'RUNNING')) continue
      // attempt 句柄：派发点（非槽位回调路径）即 claim 签发；槽位回调路径由
      // onAcquired 签发。句柄随 #executeReady 穿引到终态回写做双验证。
      const attemptRef: { current?: AttemptGuard } = {}
      if (!acquiredHook) {
        attemptRef.current = await this.#claimTask(task.id)
      }

      // 派发守卫：同一任务未 settle 前禁止再次 start。
      if (!this.#beginDispatch(task.id)) continue

      this.#activeByRole.set(key, {
        role_id: role.id,
        task_id: task.id,
        subject: subjectLabel(task),
        started_at: new Date().toISOString(),
        phase: acquiredHook ? 'queued' : 'running',
      })
      // 本轮已派发任务并入写域集合：同批后续就绪任务的重叠检测可见（排队期
      // 库内仍是 WAITING，仅靠库内状态会漏报同批并行重叠）。
      if (task.write_scopes.length > 0) {
        inProgressScopes.push({ taskId: task.id, scopes: task.write_scopes })
      }
      // 执行完无论成败都释放占用并重泵；异常在 #executeTaskSafely 内收敛为终态。
      // 角色释放是会话全局事件（doc/05 §6.5 P1-G G-①）：互斥额度跨 DAG 共占，
      // 唤醒也必须跨 DAG——遍历全部活跃 runs 重泵，拾取其他任务组中因本角色
      // 占位而滞留的 WAITING 任务（否则角色空闲、他组任务永久饿死）。
      // #pump 幂等（就绪判定 + 角色忙检查 + canTransition 三重闸），空泵无害。
      void this.#executeReady(run, task, role, acquiredHook, attemptRef).finally(() => {
        this.#endDispatch(task.id)
        this.#activeByRole.delete(key)
        for (const activeDagId of this.#runs.keys()) {
          this.#enqueue(activeDagId)
        }
      })
    }
  }

  /**
   * 执行单个就绪任务：fallback 重试一次；按映射写终态并广播通知。
   * `deferRunning`（假并行修复）：true 时「写 RUNNING + 开始通知」后移到
   * context.onAcquired（DelegationService 拿到执行器槽后触发）；false 保持
   * 派发点立即通知的历史行为。
   */
  async #executeReady(run: DagRunContext, task: TaskRecord, role: RoleConfig, deferRunning: boolean): Promise<void> {
    if (!deferRunning) {
      this.#notifySafe(run, `[weave] 任务「${subjectLabel(task)}」开始 → ${role.name}`)
    }
    const controller = new AbortController()
    this.#controllers.set(task.id, controller)
    if (!deferRunning) this.#startHeartbeat(task.id)

    // 真·RUNNING 时点（槽位回调）：排队期被外部取消/治理（终态）时不覆写；
    // memberRuntime 阶段同点翻转 queued → running。
    const onAcquired = deferRunning
      ? async (): Promise<void> => {
          const current = (await this.#currentStatus(task.id)) ?? task.status
          if (current !== 'WAITING' && current !== 'RUNNING') return
          await this.#updateTask(task.id, { status: 'RUNNING' })
          this.#startHeartbeat(task.id)
          const info = this.#activeByRole.get(activeKey(run.sessionId, role.id, task.id))
          if (info) info.phase = 'running'
          this.#notifySafe(run, `[weave] 任务「${subjectLabel(task)}」开始 → ${role.name}`)
        }
      : undefined

    const requirement =
      `这是团队「${run.team.name}」任务「${subjectLabel(task)}」（队长拆解）。聚焦完成本任务目标；下游成员将基于你的产出继续。`

    let output: SubagentTaskOutput
    try {
      // 上游产物采集挪入 try：持久层异常随执行失败路径收敛（此前是 unhandled
      // rejection——角色槽虽经 .finally 释放，但错误无日志且可能告警到进程级）。
      const upstreamOutputs = await this.#collectUpstream(run, task)
      try {
        output = await this.#opts.delegation.executeTask(
          task,
          role,
          run.team,
          { parentAgent: run.parentAgent, sessionId: run.sessionId, upstreamOutputs, outputRequirements: requirement, onAcquired },
          controller.signal,
        )
      } catch (error) {
        if (controller.signal.aborted) throw error
        if (!this.fallbackEnabled(role)) throw error
        const fallbackRole: RoleConfig = { ...role, provider: role.fallback_provider, model: role.fallback_model }
        this.#notifySafe(run, `[weave] 任务「${subjectLabel(task)}」主模型失败，使用备用模型重试`)
        output = await this.#opts.delegation.executeTask(
          task,
          fallbackRole,
          run.team,
          {
            parentAgent: run.parentAgent,
            sessionId: run.sessionId,
            upstreamOutputs,
            outputRequirements: `${requirement}（备用模型重试）`,
            onAcquired,
          },
          controller.signal,
        )
      }
    } catch (error) {
      this.#controllers.delete(task.id)
      // 取消竞态收敛：abort 先于外部 CANCELLED 落库时按取消语义收敛，避免用户
      // 取消被竞态误判成 FAILED（onExternalCancel 幂等，重复调用不重复发电）。
      if (controller.signal.aborted) {
        await this.#forceTransition(task, 'CANCELLED', { error_type: 'cancelled' })
        this.#notifySafe(run, `[weave] 任务「${subjectLabel(task)}」已取消`)
        await this.#afterTaskSettled(run, task, 'CANCELLED')
        return
      }
      // 基础设施故障或取消：外部取消时 DB 已是 CANCELLED 则尊重现状
      const current = (await this.#currentStatus(task.id)) ?? task.status
      if (current === 'CANCELLED') {
        this.#notifySafe(run, `[weave] 任务「${subjectLabel(task)}」已取消`)
        await this.#afterTaskSettled(run, task, 'CANCELLED')
        return
      }
      await this.#forceTransition(task, 'FAILED', { error_type: 'execution_failed' })
      this.#notifySafe(
        run,
        `[weave] 任务「${subjectLabel(task)}」执行失败 ✗：${error instanceof Error ? error.message : String(error)}`,
      )
      await this.#afterTaskSettled(run, task, 'FAILED')
      return
    }
    this.#controllers.delete(task.id)

    // 外部取消先行写了 CANCELLED（含下游 SKIPPED 传播）→ 不覆写
    const current = (await this.#currentStatus(task.id)) ?? task.status
    if (current === 'CANCELLED') {
      this.#notifySafe(run, `[weave] 任务「${subjectLabel(task)}」已取消`)
      await this.#afterTaskSettled(run, task, 'CANCELLED')
      return
    }

    const mapped = output.weave ?? mappingFallback(output)
    const text = outputTextOf(output)

    if (mapped.status === 'COMPLETED') {
      await this.#updateTask(task.id, { status: 'COMPLETED', result: text, error_type: null })
      this.#notifySafe(
        run,
        `[weave] 任务「${subjectLabel(task)}」完成 ✓（${role.name}）\n${excerptOf(text, 600)}`,
      )
      await this.#runSettledTextHook(run, task, role, text, 'COMPLETED')
      await this.#afterTaskSettled(run, task, 'COMPLETED')
      return
    }

    if (mapped.status === 'CANCELLED') {
      await this.#forceTransition(task, 'CANCELLED', { error_type: mapped.errorType ?? 'aborted' })
      this.#notifySafe(run, `[weave] 任务「${subjectLabel(task)}」已中断（${output.stopReason}）`)
      await this.#afterTaskSettled(run, task, 'CANCELLED')
      return
    }

    // FAILED：权威状态机向下游传播 SKIPPED
    await this.#forceTransition(task, 'FAILED', {
      result: text,
      error_type: mapped.errorType ?? output.stopReason,
    })
    const diagnostic = output.diagnostic ? `：${output.diagnostic}` : ''
    this.#notifySafe(
      run,
      `[weave] 任务「${subjectLabel(task)}」失败 ✗（${mapped.errorType ?? output.stopReason}${diagnostic}）`,
    )
    await this.#runSettledTextHook(run, task, role, text, 'FAILED')
    await this.#afterTaskSettled(run, task, 'FAILED')
  }

  fallbackEnabled(role: RoleConfig): boolean {
    return (this.#opts.retryWithFallback ?? true) && Boolean(role.fallback_provider && role.fallback_model)
  }

  /** 终态反思钩子：单一入口，COMPLETED/FAILED 共用；异常与通知失败均不阻断主链路。 */
  async #runSettledTextHook(
    run: DagRunContext,
    task: TaskRecord,
    role: RoleConfig,
    text: string,
    status: 'COMPLETED' | 'FAILED',
  ): Promise<void> {
    const hook = this.#opts.onTaskSettledText
    if (!hook) return
    try {
      const count = await hook({ task, role, team: run.team, text, status })
      if (typeof count === 'number' && count > 0) {
        this.#notifySafe(run, `[weave] 反思沉淀 ${count} 条候选知识（待审核）`)
      }
    } catch (error) {
      this.#opts.log?.warn?.('[dsh-weave] reflection hook failed:', error)
    }
  }

  /** 单任务终态后的公共收敛：失败/取消向下游传播 SKIPPED → 刷 DAG 状态 → 重泵。 */
  async #afterTaskSettled(run: DagRunContext, task: TaskRecord, finalStatus: TaskStatus): Promise<void> {
    try {
      if (finalStatus === 'FAILED' || finalStatus === 'CANCELLED' || finalStatus === 'BANNED' || finalStatus === 'LOOP_TERMINATED') {
        const dag = await this.loadDag(run.dagId)
        const propagated = TaskStateMachine.propagateFailure(
          { ...dag, tasks: dag.tasks.map((item) => (item.id === task.id ? { ...item, status: finalStatus } : item)) },
          task.id,
        )
        await this.#persistSkipped(propagated.skipped)
      }
      await this.#persistDagStatus(run.dagId)
    } catch (error) {
      this.#opts.log?.warn?.('[dsh-weave] settle propagation failed:', error)
    }
    // 终态收敛边沿（含下游 SKIPPED 批量落库后再发一次，覆盖传播产物）。
    this.#activity.notify(run.dagId)
    this.#enqueue(run.dagId)
  }

  /** 上游成功产物的注入列表（label=成员(主题)，内容取 tasks.result）。 */
  async #collectUpstream(run: DagRunContext, task: TaskRecord): Promise<Array<{ label: string; output: string }>> {
    if (task.dependencies.length === 0) return []
    const dag = await this.loadDag(run.dagId)
    const byId = new Map(dag.tasks.map((item) => [item.id, item]))
    const outputs: Array<{ label: string; output: string }> = []
    for (const depId of task.dependencies) {
      const dep = byId.get(depId)
      if (!dep) continue
      const role = run.team.roles.find((r) => r.id === dep.assigned_agent)
      const label = `${role?.name ?? dep.assigned_agent ?? '上游'}（${subjectLabel(dep)}）`
      const text = typeof dep.result === 'string' && dep.result.trim() !== '' ? dep.result : ''
      outputs.push({ label, output: text === '' ? '（无文本输出）' : text })
    }
    return outputs
  }

  /**
   * 任务活动心跳：运行中的任务即使没有状态转移，也定期刷新 updated_at，
   * 避免“子代理正在工作但任务表看起来卡死”导致队长误判取消。
   */
  #startHeartbeat(taskId: string): void {
    if (this.#heartbeats.has(taskId)) return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const current = await this.#currentStatus(taskId)
          if (!current || TERMINAL_STATUSES.has(current)) {
            this.#stopHeartbeat(taskId)
            return
          }
          await this.#persistence.tasks.run((db) =>
            db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), taskId),
          )
        } catch {
          // 心跳失败不阻断主链路。
        }
      })()
    }, 15_000)
    this.#heartbeats.set(taskId, timer)
  }

  #stopHeartbeat(taskId: string): void {
    const timer = this.#heartbeats.get(taskId)
    if (timer) {
      clearInterval(timer)
      this.#heartbeats.delete(taskId)
    }
  }

  async #currentStatus(taskId: string): Promise<TaskStatus | null> {
    const row = await this.#persistence.tasks.run((db) => {
      return db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: TaskStatus } | undefined
    })
    return row?.status ?? null
  }

  /**
   * 收集会话内 in-progress 任务的写域（写域重叠提醒数据源）：
   * 库内 RUNNING/REVISION_RUNNING + 角色占用表任务（覆盖排队中——已派发未拿槽
   * 的任务库内仍是 WAITING）。只返回非空写域；self 由调用方按 taskId 排除。
   */
  async #inProgressScopes(sessionId: string): Promise<Array<{ taskId: string; scopes: string[] }>> {
    const activeTaskIds = new Set<string>()
    for (const [key, info] of this.#activeByRole.entries()) {
      if (key.split('\u0000')[0] === sessionId) activeTaskIds.add(info.task_id)
    }
    return this.#persistence.tasks.run((db) => {
      const entries: Array<{ taskId: string; scopes: string[] }> = []
      const seen = new Set<string>()
      const push = (id: string, raw: string | null): void => {
        if (seen.has(id)) return
        seen.add(id)
        const scopes = parseWriteScopes(raw)
        if (scopes.length > 0) entries.push({ taskId: id, scopes })
      }
      const statusRows = db
        .prepare("SELECT id, write_scopes FROM tasks WHERE session_id = ? AND status IN ('RUNNING','REVISION_RUNNING')")
        .all(sessionId) as Array<{ id: string; write_scopes: string | null }>
      for (const row of statusRows) push(row.id, row.write_scopes)
      if (activeTaskIds.size > 0) {
        const placeholders = [...activeTaskIds].map(() => '?').join(', ')
        const activeRows = db
          .prepare(`SELECT id, write_scopes FROM tasks WHERE id IN (${placeholders})`)
          .all(...activeTaskIds) as Array<{ id: string; write_scopes: string | null }>
        for (const row of activeRows) push(row.id, row.write_scopes)
      }
      return entries
    })
  }

  /**
   * 终态落库：优先走权威状态机；源状态已被并发写走导致非法转移时
   * 记警告并强制写目标值（保证失败/取消可达，不允许悬挂 RUNNING）。
   */
  async #forceTransition(
    task: TaskRecord,
    target: TaskStatus,
    extra: { result?: string; error_type?: string | null } = {},
  ): Promise<void> {
    const current = (await this.#currentStatus(task.id)) ?? task.status
    if (current !== target && !TaskStateMachine.canTransition(current, target)) {
      this.#opts.log?.warn?.(`[dsh-weave] illegal transition ${current} -> ${target}（强制落库）`)
    }
    await this.#updateTask(task.id, { status: target, ...extra })
  }

  #notifySafe(run: DagRunContext, text: string): void {
    try {
      this.#opts.notify(run.sessionId, text, noticeTargetOf(run.parentAgent))
    } catch (error) {
      this.#opts.log?.warn?.('[dsh-weave] notify failed:', error)
    }
  }

  /**
   * 知识审核闭环：DAG 收敛时候选 >0，给队长发可执行的审核指令——candidate
   * 不转 active 不参与注入，无人审核即永久积压（孤儿环节修复）。
   */
  async #notifyKnowledgeReview(run: DagRunContext): Promise<void> {
    const count = this.#opts.countKnowledgeCandidates
    if (!count) return
    try {
      const pending = await count()
      if (pending > 0) {
        this.#notifySafe(
          run,
          `[weave] 知识库有 ${pending} 条候选待审：用 weave_knowledge_review 查看，值得保留的逐条 weave_knowledge_approve，无价值的 weave_knowledge_reject。candidate 未转 active 不参与注入，请审完防止积压。`,
        )
      }
    } catch (error) {
      this.#opts.log?.warn?.('[dsh-weave] knowledge candidate count failed:', error)
    }
  }

  /**
   * DAG 收敛后自动为交付目录构建代码图谱，并回灌队长会话一条更新通知。
   * 交付目录从任务描述中的首个绝对路径提取（队长派单 prompt 恒携带目标目录）；
   * 提取不到/构建失败静默降级——图谱是增强信息，不得影响主链路。
   */
  async #notifyGraphBuild(run: DagRunContext, dag: TaskDag): Promise<void> {
    try {
      const texts = dag.tasks.map((task) => String(task.description ?? ''))
      const root = firstDeliveryRoot(texts)
      if (root === '' || !existsSync(root)) return
      const graph = new GraphService({ projectRoot: root })
      const built = await graph.build()
      this.#notifySafe(
        run,
        `[weave] 代码图谱已更新：${built.graphPath.split(String.fromCharCode(92)).join('/')}（可用 weave_graph_query / weave_graph_path 查询变更影响）`,
      )
    } catch (error) {
      this.#opts.log?.warn?.('[dsh-weave] auto graph build failed:', error)
    }
  }

  #notifySummary(run: DagRunContext, dag: TaskDag): void {
    const lines: string[] = []
    for (const task of dag.tasks) {
      const icon =
        SUCCESS_TERMINALS.has(task.status)
          ? '✓'
          : task.status === 'SKIPPED'
            ? '⊘（依赖中断）'
            : task.status === 'CANCELLED'
              ? '∅（已取消）'
              : '✗（失败）'
      lines.push(`- ${icon} 「${subjectLabel(task)}」[${task.status}] ${roleNameOf(run.team, task)}`)
    }
    const hasFailure = dag.tasks.some(
      (task) => TaskStateMachine.isFailureTerminal(task.status) || task.status === 'SKIPPED',
    )
    lines.push(
      hasFailure
        ? '存在失败或跳过的任务：可在会话面板对失败项执行重试/跳过，处理完成后再向用户汇报。'
        : '全部任务已完成：请基于以上各成员产出做最终汇总答复用户。',
    )
    this.#notifySafe(run, `[weave] 任务图 ${run.dagId} 已结束\n${lines.join('\n')}`)
  }
}

/* ------------------------------ 辅助 ------------------------------ */

function activeKey(sessionId: string, roleId: string, taskId: string): string {
  return `${sessionId}\u0000${roleId}\u0000${taskId}`
}

function activeRolePrefix(sessionId: string, roleId: string): string {
  return `${sessionId}\u0000${roleId}\u0000`
}

function safeParseDeps(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

/** 任务主题：描述首行截 60 字（空描述退回任务 id）；反思兑底候选标题同源。 */
export function subjectLabel(task: TaskRecord): string {
  const firstLine = task.description.split('\n')[0]?.trim() ?? ''
  return firstLine === '' ? task.id : firstLine.slice(0, 60)
}

function roleNameOf(team: TeamConfig, task: TaskRecord): string {
  return team.roles.find((r) => r.id === task.assigned_agent)?.name ?? task.assigned_agent ?? '—'
}

function excerptOf(text: string, maxChars: number): string {
  const trimmed = text.trim()
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed
}

/** 从任务描述提取首个绝对路径作为交付根目录（win 形态；队长 prompt 恒带目标目录）。 */
function firstDeliveryRoot(texts: string[]): string {
  for (const text of texts) {
    const match = text.match(/[A-Za-z]:[\\/][^\s"'，。；）)]+/)
    if (match !== null) return match[0] ?? ''
  }
  return ''
}

/** 尽量从父 Agent 上取 durable log 追加面（pre-step 载荷同构；缺失时通知仅走日志）。 */
function noticeTargetOf(parentAgent: unknown): NoticeSessionLike | undefined {
  const candidate = parentAgent as { session?: NoticeSessionLike } | undefined
  return candidate?.session
}
