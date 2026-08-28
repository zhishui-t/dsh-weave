import type { SubagentTaskOutput } from './delegation-service.js'
import type { RoleConfig, TeamConfig } from './team-manager.js'
import type { WeavePersistence } from './persistence/persistence.js'
import { toDagStatus } from './dag/repository.js'
import { TaskStateMachine } from './state/task-state-machine.js'
import type { TaskDag, TaskRecord, TaskStatus } from './state/types.js'
import { WeaveError } from './state/weave-error.js'
import type { NoticeSessionLike } from './session-delegation.js'

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

/** DelegationService 的最小视面（测试可注入替身）。 */
export interface SchedulerDelegationLike {
  executeTask(
    task: TaskRecord,
    role: RoleConfig,
    team: TeamConfig,
    context: {
      parentAgent?: unknown
      upstreamOutputs?: Array<{ label: string; output: string }>
      outputRequirements?: string
    },
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
  /** `${sessionId}\u0000${roleId}` → 运行时占用（并发上限仲裁 + 成员状态展示）。 */
  readonly #activeByRole = new Map<string, MemberRuntimeInfo>()
  /** dagId → 泵序列化链（避免同一 DAG 并发泵）。 */
  readonly #chains = new Map<string, Promise<void>>()

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
    if (!this.#runs.has(input.dagId)) {
      const existing = await this.#persistence.tasks.run((db) => {
        return db.prepare('SELECT team_id FROM dags WHERE dag_id = ?').get(input.dagId) as
          | { team_id: string }
          | undefined
      })
      if (!existing) {
        throw new WeaveError('task_not_found', `DAG 不存在: ${input.dagId}`, { dagId: input.dagId })
      }
      const team = this.#opts.loadTeam(existing.team_id)
      this.#runs.set(input.dagId, {
        dagId: input.dagId,
        sessionId: input.sessionId,
        team,
        parentAgent: input.parentAgent,
        settledNotified: false,
      })
    } else {
      // 重入：刷新通知面（同一会话续聊时拿到最新 session 对象）。
      const run = this.#runs.get(input.dagId)!
      if (input.parentAgent !== undefined) run.parentAgent = input.parentAgent
    }
    await this.#enqueue(input.dagId)
  }

  /** UI/MCP 取消联动：中止运行中的子代理并重泵该任务所在 DAG 以收敛状态。 */
  async onExternalCancel(taskId: string): Promise<void> {
    this.#controllers.get(taskId)?.abort()
    const dagId = await this.#dagIdOf(taskId)
    if (dagId) await this.#enqueue(dagId)
  }

  /**
   * UI/MCP 重试联动（task_retry 已把状态改为 WAITING）：
   * 恢复该任务下游被 SKIPPED 的成员任务并重新泵 DAG。
   */
  async onExternalRetry(taskId: string): Promise<void> {
    const dagId = await this.#dagIdOf(taskId)
    if (!dagId || !this.#runs.has(dagId)) return
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
      }
    } catch (error) {
      this.#opts.log?.warn?.('[dsh-weave] resume reactivate failed:', error)
    }
    await this.#enqueue(dagId)
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
    this.#runs.clear()
    this.#activeByRole.clear()
  }

  /* ------------------------------ 持久化读写 ------------------------------ */

  loadDag(dagId: string): Promise<TaskDag> {
    return this.#persistence.tasks.run((db) => {
      const dagRow = db.prepare('SELECT * FROM dags WHERE dag_id = ?').get(dagId) as Record<string, string> | undefined
      if (!dagRow) throw new WeaveError('task_not_found', `DAG 不存在: ${dagId}`, { dagId })
      const rows = db
        .prepare('SELECT * FROM tasks WHERE dag_id = ? ORDER BY rowid')
        .all(dagId) as unknown as Array<Omit<TaskRecord, 'dependencies' | 'skip_override'> & { dependencies: string; skip_override: number }>
      const edges = db
        .prepare('SELECT from_task_id AS "from", to_task_id AS "to" FROM edges WHERE dag_id = ?')
        .all(dagId) as unknown as TaskDag['edges']
      const tasks: TaskRecord[] = rows.map((row) => ({
        ...row,
        dependencies: safeParseDeps(row.dependencies),
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

  async #updateTask(
    taskId: string,
    patch: Partial<Pick<TaskRecord, 'status' | 'result' | 'error_type'>>,
  ): Promise<void> {
    await this.#persistence.tasks.run((db) => {
      const sets = ['updated_at = ?']
      const params: Array<string | null> = [new Date().toISOString()]
      for (const [field, value] of Object.entries(patch)) {
        sets.push(`${field} = ?`)
        params.push(value === undefined ? null : String(value))
      }
      params.push(taskId)
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params)
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
      }
      return
    }

    // 依赖满足度晋升：BLOCKED 且上游全部成功终态 → WAITING（状态机无 BLOCKED→RUNNING 直达）
    const byId0 = new Map(dag.tasks.map((task) => [task.id, task]))
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

      // 状态机无 BLOCKED→RUNNING 直达：先升 WAITING 再 RUNNING（TDD §2.1.5）
      if (!TaskStateMachine.canTransition(task.status, 'RUNNING')) continue
      await this.#updateTask(task.id, { status: 'RUNNING' })

      this.#activeByRole.set(key, {
        role_id: role.id,
        task_id: task.id,
        subject: subjectLabel(task),
        started_at: new Date().toISOString(),
      })
      // 执行完无论成败都释放占用并重泵；异常在 #executeTaskSafely 内收敛为终态。
      void this.#executeReady(run, task, role).finally(() => {
        this.#activeByRole.delete(key)
        this.#enqueue(dagId)
      })
    }
  }

  /** 执行单个就绪任务：fallback 重试一次；按映射写终态并广播通知。 */
  async #executeReady(run: DagRunContext, task: TaskRecord, role: RoleConfig): Promise<void> {
    this.#notifySafe(run, `[weave] 任务「${subjectLabel(task)}」开始 → ${role.name}`)
    const controller = new AbortController()
    this.#controllers.set(task.id, controller)

    const upstreamOutputs = await this.#collectUpstream(run, task)
    const requirement =
      `这是团队「${run.team.name}」任务「${subjectLabel(task)}」（队长拆解）。聚焦完成本任务目标；下游成员将基于你的产出继续。`

    let output: SubagentTaskOutput
    try {
      try {
        output = await this.#opts.delegation.executeTask(
          task,
          role,
          run.team,
          { parentAgent: run.parentAgent, upstreamOutputs, outputRequirements: requirement },
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
            upstreamOutputs,
            outputRequirements: `${requirement}（备用模型重试）`,
          },
          controller.signal,
        )
      }
    } catch (error) {
      this.#controllers.delete(task.id)
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

  async #currentStatus(taskId: string): Promise<TaskStatus | null> {
    const row = await this.#persistence.tasks.run((db) => {
      return db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: TaskStatus } | undefined
    })
    return row?.status ?? null
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

function subjectLabel(task: TaskRecord): string {
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

/** 尽量从父 Agent 上取 durable log 追加面（pre-step 载荷同构；缺失时通知仅走日志）。 */
function noticeTargetOf(parentAgent: unknown): NoticeSessionLike | undefined {
  const candidate = parentAgent as { session?: NoticeSessionLike } | undefined
  return candidate?.session
}
