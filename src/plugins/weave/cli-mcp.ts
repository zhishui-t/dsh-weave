import type { DagRepository } from './dag/repository.js'
import type { ExecutorRegistry } from './executor-registry.js'
import type { FeedbackRouter } from './feedback-router.js'
import type { KnowledgeReviewService } from './knowledge-review.js'
import type { KnowledgeStore, KnowledgeMeta, KnowledgeLayer, KnowledgeStatus } from './knowledge-model.js'
import type { WeavePersistence } from './persistence/index.js'
import { TaskStateMachine } from './state/task-state-machine.js'
import type { CircuitBreaker, BreakerRecord } from './safety/circuit-breaker.js'
import type { TaskRecord, TaskStatus } from './state/types.js'
import { WeaveError } from './state/weave-error.js'
import type { TeamManager } from './team-manager.js'

/**
 * P0-CLI-014 —— CLI / MCP 基础（TDD 1.2.x + AC-CLI）。
 *
 * 交付：
 * - `WeaveMcp`：MCP Tool 层——weave_submit_task / weave_get_status /
 *   weave_revise_task / weave_accept_task / weave_team_list / weave_team_switch /
 *   weave_executor_list（执行器列表）；全部返回结构化 JSON 数据；
 * - `WeaveCli`：`/weave` 斜杠命令解析器——team list/switch、task submit/status/
 *   revise/accept、executor list、dag <id>；默认人类可读文本，`--json` 输出结构化 JSON；
 * - 错误可读：WeaveError(code) → `error: {code}: {message}`（文本）/ {ok:false,error}（JSON）。
 *
 * 复用（依赖注入）：TeamManager（团队加载/校验/会话绑定）、ExecutorRegistry（执行器
 * 列表与校验）、FeedbackRouter（修订/确认）、DagRepository（DAG 查询/取消）、
 * TaskStateMachine（状态机校验）、WeavePersistence（tasks/dags/edges/task_sequences）。
 */

export interface CliMcpDeps {
  persistence: WeavePersistence
  teamManager: TeamManager
  executorRegistry: ExecutorRegistry
  feedbackRouter: FeedbackRouter
  dagRepository: DagRepository
  /** 知识审核服务（P0-KREVIEW-012，t14）。 */
  knowledgeReview?: KnowledgeReviewService
  /** KnowledgeStore：knowledge_review 非 candidate 状态查询用。 */
  knowledgeStore?: KnowledgeStore
  /** 熔断器（P0-SAFETY-015，t8）：ban list 用。 */
  circuitBreaker?: CircuitBreaker
}

/* ============================ MCP Tool 层 ============================ */

export interface SubmitTaskInput {
  description: string
  project_id: string
  version: string
  session_id?: string
  team_id?: string
  dependencies?: Array<{ task_id: string; artifacts?: string[] }>
}

export interface SubmitTaskOutput {
  dag_id: string
  tasks: TaskRecord[]
  status: 'submitted'
}

export interface GetStatusInput {
  dag_id?: string
  task_id?: string
}

export interface GetStatusOutput {
  dag_id?: string
  tasks: TaskRecord[]
}

export class WeaveMcp {
  readonly #deps: CliMcpDeps

  constructor(deps: CliMcpDeps) {
    this.#deps = deps
  }

  /** weave_submit_task：校验入参 → 选择/加载团队 → 单任务 DAG（阶段=execute）落库。 */
  async submitTask(input: SubmitTaskInput): Promise<SubmitTaskOutput> {
    const { description, project_id: projectId, version } = input
    if (typeof description !== 'string' || description.trim() === '') {
      throw new WeaveError('invalid_argument', 'description 不能为空', { field: 'description' })
    }
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new WeaveError('invalid_argument', 'project_id 不能为空', { field: 'project_id' })
    }
    if (typeof version !== 'string' || version.trim() === '') {
      throw new WeaveError('invalid_argument', 'version 不能为空', { field: 'version' })
    }

    // 团队：显式 > 会话绑定 > 默认 > 唯一 > 提示选择（null → invalid_team）
    const team =
      input.team_id !== undefined && input.team_id !== ''
        ? this.#deps.teamManager.loadTeam(input.team_id) // 显式：invalid_team / executor_unavailable 原样冒泡
        : await this.#deps.teamManager.selectTeam(input.session_id ?? 'cli-session', undefined)
    if (!team) {
      throw new WeaveError('invalid_team', '无可用团队，请先执行 /weave team switch <team_id>', {
        session_id: input.session_id ?? 'cli-session',
      })
    }
    this.#deps.teamManager.validateTeam(team, this.#deps.executorRegistry)

    // 阶段 → 角色绑定（SDD 2.2.7）：'execute' 隐式角色匹配兜底
    const stage = 'execute'
    const role =
      team.roles.find((r) => r.stages.includes(stage)) ?? team.roles.find((r) => r.id === stage) ?? team.roles[0]
    if (!role) {
      throw new WeaveError('configuration_error', '团队未声明任何角色，无法绑定执行器', { team_id: team.team_id })
    }

    // 全局任务 ID：task_sequences（(project, version) 内连续）
    const seq = await this.#nextSequence(projectId, version)
    const dagId = `dag-${projectId}-${version}-${seq}`
    const taskId = `${dagId}-t1`

    // 依赖校验：依赖任务必须已存在（TDD 1.2.1 dependencies）
    const dependencyIds = input.dependencies?.map((d) => d.task_id) ?? []
    for (const depId of dependencyIds) {
      const exists = await this.#deps.persistence.tasks.run((db) => {
        return db.prepare('SELECT id FROM tasks WHERE id = ?').get(depId) !== undefined
      })
      if (!exists) {
        throw new WeaveError('task_not_found', `依赖任务不存在: ${depId}`, { taskId: depId })
      }
    }
    const allTerminal = await this.#allDepsTerminal(dependencyIds)
    const status: TaskStatus = dependencyIds.length === 0 || allTerminal ? 'WAITING' : 'BLOCKED'

    const now = new Date().toISOString()
    const task: TaskRecord = {
      id: taskId,
      session_id: input.session_id ?? 'cli-session',
      team_id: team.team_id,
      project_id: projectId,
      version,
      description,
      dependencies: dependencyIds,
      assigned_agent: role.id,
      executor: role.executor,
      status,
      revision_count: 0,
      max_revisions: team.feedback.max_revisions,
      feedback_timeout_seconds: team.feedback.feedback_timeout_seconds,
      feedback_expires_at: null,
      skip_override: false,
      skip_reason: null,
      fail_count: 0,
      result: null,
      error_type: null,
      created_at: now,
      updated_at: now,
    }

    await this.#deps.persistence.tasks.run((db) => {
      db.prepare(
        `INSERT INTO dags (dag_id, team_id, project_id, version, difficulty, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'created', ?, ?)`,
      ).run(dagId, team.team_id, projectId, version, team.task_decomposition.default_difficulty ?? 'hard', now, now)
      db.prepare(
        `INSERT INTO tasks (id, dag_id, session_id, team_id, project_id, version, description, stage,
         dependencies, assigned_agent, executor, status, revision_count, max_revisions,
         feedback_timeout_seconds, feedback_expires_at, skip_override, skip_reason, fail_count,
         result, error_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL, NULL, ?, ?)`,
      ).run(
        taskId, dagId, task.session_id, task.team_id, projectId, version, description, stage,
        JSON.stringify(dependencyIds), role.id, role.executor, status, 0, task.max_revisions,
        task.feedback_timeout_seconds, null, now, now,
      )
      for (const depId of dependencyIds) {
        db.prepare('INSERT OR IGNORE INTO edges (dag_id, from_task_id, to_task_id) VALUES (?, ?, ?)').run(dagId, depId, taskId)
      }
    })

    return { dag_id: dagId, tasks: [task], status: 'submitted' }
  }

  async #nextSequence(projectId: string, version: string): Promise<number> {
    return this.#deps.persistence.core.run((db) => {
      db.prepare('INSERT OR IGNORE INTO task_sequences (project_id, version, next_n) VALUES (?, ?, 0)').run(projectId, version)
      const row = db
        .prepare('UPDATE task_sequences SET next_n = next_n + 1 WHERE project_id = ? AND version = ? RETURNING next_n')
        .get(projectId, version) as { next_n: number }
      return row.next_n
    })
  }

  async #allDepsTerminal(dependencyIds: string[]): Promise<boolean> {
    if (dependencyIds.length === 0) return true
    const rows = await this.#deps.persistence.tasks.run((db) => {
      const placeholders = dependencyIds.map(() => '?').join(', ')
      return db.prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders})`).all(...dependencyIds) as { id: string; status: string }[]
    })
    const byId = new Map(rows.map((r) => [r.id, r.status]))
    return dependencyIds.every((id) => {
      const status = byId.get(id) as TaskStatus | undefined
      return status !== undefined && (status === 'COMPLETED' || status === 'CLOSED')
    })
  }

  /** weave_get_status：dag_id / task_id 至少其一。 */
  async getStatus(input: GetStatusInput): Promise<GetStatusOutput> {
    const { dag_id: dagId, task_id: taskId } = input
    if (!dagId && !taskId) {
      throw new WeaveError('invalid_argument', 'dag_id 与 task_id 至少提供一个', { input })
    }
    if (dagId) {
      const dag = await this.#deps.dagRepository.loadDag(dagId)
      return { dag_id: dag.dag_id, tasks: dag.tasks }
    }
    const task = await this.#loadTask(taskId!)
    const rowDagId = await this.#deps.persistence.tasks.run((db) => {
      const row = db.prepare('SELECT dag_id FROM tasks WHERE id = ?').get(taskId!) as { dag_id: string } | undefined
      return row?.dag_id ?? ''
    })
    if (rowDagId) {
      const dag = await this.#deps.dagRepository.loadDag(rowDagId)
      return { dag_id: rowDagId, tasks: dag.tasks }
    }
    return { tasks: [task] }
  }

  /** weave_revise_task：保温期修订（FeedbackRouter.revise）。 */
  async reviseTask(input: { task_id: string; feedback: string }): Promise<{ task_id: string; status: TaskStatus; revision_count: number }> {
    if (typeof input.feedback !== 'string' || input.feedback.trim() === '') {
      throw new WeaveError('invalid_argument', 'feedback 不能为空', { field: 'feedback' })
    }
    const task = await this.#deps.feedbackRouter.revise(input.task_id, input.feedback)
    return { task_id: task.id, status: task.status, revision_count: task.revision_count }
  }

  /** weave_accept_task：确认完成并关闭（FeedbackRouter.accept）。 */
  async acceptTask(input: { task_id: string }): Promise<{ task_id: string; status: 'CLOSED' }> {
    const task = await this.#deps.feedbackRouter.accept(input.task_id)
    return { task_id: task.id, status: task.status as 'CLOSED' }
  }

  /** weave_team_list：可用团队列表（按文件名排序）。 */
  async teamList(): Promise<{ teams: Array<{ team_id: string; name: string; default: boolean; roles: string[] }> }> {
    const teams = this.#deps.teamManager.listTeams()
    return {
      teams: teams.map((t) => ({
        team_id: t.team_id,
        name: t.name,
        default: t.default,
        roles: t.roles.map((r) => r.id),
      })),
    }
  }

  /** weave_team_switch：校验并持久化会话绑定（team_bindings，ME-4）。 */
  async teamSwitch(input: { team_id: string; session_id?: string }): Promise<{ session_id: string; team_id: string }> {
    this.#deps.teamManager.loadTeam(input.team_id) // 不存在 → invalid_team
    await this.#deps.teamManager.bindTeam(input.session_id ?? 'cli-session', input.team_id)
    return { session_id: input.session_id ?? 'cli-session', team_id: input.team_id }
  }

  /** weave_executor_list：执行器列表输出（ExecutorRegistry 当前视图）。 */
  async executorList() {
    return { executors: this.#deps.executorRegistry.list() }
  }

  /* ------------------- 补充：知识审核 / 任务运维 / 禁令列表（t36） ------------------- */

  /** weave_knowledge_review：审核队列（默认 candidate；支持 status/layer/limit，TDD 1.2.8）。 */
  async knowledgeReview(
    filter: { status?: string; layer?: string; limit?: number } = {},
  ): Promise<{ candidates: Array<KnowledgeMeta & { title?: string; tags?: string[] }> }> {
    const status = (filter.status ?? 'candidate') as KnowledgeStatus
    const KNOWN: KnowledgeStatus[] = ['candidate', 'active', 'deprecated', 'superseded']
    if (!KNOWN.includes(status)) {
      throw new WeaveError('invalid_argument', `不支持的知识状态: ${String(filter.status)}`, { status: filter.status })
    }
    const limit = filter.limit ?? 50
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new WeaveError('invalid_argument', 'limit 必须为正整数', { limit: filter.limit })
    }
    const layer = filter.layer as KnowledgeLayer | undefined
    if (status === 'candidate') {
      const review = this.#deps.knowledgeReview
      if (!review) throw new WeaveError('configuration_error', 'knowledgeReview 未注入（需要 KnowledgeReviewService）')
      const items = await review.listQueue(layer ? { layer } : {})
      return {
        candidates: items.slice(0, limit).map((item) => ({ ...item.meta, title: item.title, tags: item.tags })),
      }
    }
    const store = this.#deps.knowledgeStore
    if (!store) throw new WeaveError('configuration_error', 'knowledgeStore 未注入（非 candidate 状态查询需要）')
    const metas = await store.listMeta({ status, ...(layer ? { layer } : {}) })
    return { candidates: metas.slice(0, limit) }
  }

  /** weave_knowledge_approve：candidate → active（显式审核，AC-KNOW-003）。 */
  async knowledgeApprove(knowledgeId: string): Promise<KnowledgeMeta> {
    const review = this.#deps.knowledgeReview
    if (!review) throw new WeaveError('configuration_error', 'knowledgeReview 未注入')
    return review.approve(knowledgeId)
  }

  /** weave_knowledge_reject：candidate → deprecated。 */
  async knowledgeReject(knowledgeId: string, _reason?: string): Promise<KnowledgeMeta> {
    const review = this.#deps.knowledgeReview
    if (!review) throw new WeaveError('configuration_error', 'knowledgeReview 未注入')
    return review.reject(knowledgeId)
  }

  /** weave_task_retry：FAILED/LOOP_TERMINATED/INTERRUPTED/CANCELLED → WAITING（#18/#24/#26/#29）。 */
  async taskRetry(taskId: string): Promise<TaskRecord> {
    const task = await this.#loadTask(taskId)
    const retryable: TaskStatus[] = ['FAILED', 'LOOP_TERMINATED', 'INTERRUPTED', 'CANCELLED']
    if (!retryable.includes(task.status)) {
      throw new WeaveError('invalid_status_transition', `任务 ${taskId} 状态 ${task.status} 不可重试（仅失败/中断/取消/循环终止）`, { taskId, status: task.status })
    }
    void TaskStateMachine.transition(task.status, 'WAITING')
    await this.#updateTask(taskId, { status: 'WAITING' })
    return this.#loadTask(taskId)
  }

  /** weave_task_skip：失败/熔断/中断/取消态 → SKIPPED（skip_override=1，人工跳过）。 */
  async taskSkip(taskId: string): Promise<TaskRecord> {
    const task = await this.#loadTask(taskId)
    if (!TaskStateMachine.canTransition(task.status, 'SKIPPED')) {
      throw new WeaveError('invalid_status_transition', `任务 ${taskId} 状态 ${task.status} 不可跳过`, { taskId, status: task.status })
    }
    void TaskStateMachine.transition(task.status, 'SKIPPED')
    await this.#deps.persistence.tasks.run((db) => {
      db.prepare("UPDATE tasks SET status = 'SKIPPED', skip_override = 1, skip_reason = ?, updated_at = ? WHERE id = ?")
        .run('人工跳过', new Date().toISOString(), taskId)
    })
    return this.#loadTask(taskId)
  }

  /** weave_task_cancel：任务取消（复用 DagRepository.cancelTask，含下游 SKIPPED 传播）。 */
  async taskCancel(taskId: string): Promise<TaskRecord> {
    const { dag_id: dagId } = (await this.#deps.persistence.tasks.run((db) => {
      return db.prepare('SELECT dag_id FROM tasks WHERE id = ?').get(taskId) as { dag_id: string } | undefined
    })) ?? { dag_id: '' }
    if (dagId) {
      const dag = await this.#deps.dagRepository.cancelTask(dagId, taskId)
      const updated = dag.tasks.find((t) => t.id === taskId)
      if (!updated) throw new WeaveError('task_not_found', `任务不存在: ${taskId}`, { taskId })
      return updated
    }
    // 兼容无 dag_id 的早期行：状态机直移 + 更新
    const task = await this.#loadTask(taskId)
    void TaskStateMachine.transition(task.status, 'CANCELLED')
    await this.#updateTask(taskId, { status: 'CANCELLED' })
    return this.#loadTask(taskId)
  }

  /** weave_task_reopen：CLOSED → AWAITING_FEEDBACK（24h 窗口，复用 FeedbackRouter #17）。 */
  async taskReopen(taskId: string): Promise<TaskRecord> {
    return this.#deps.feedbackRouter.reopen(taskId)
  }

  /** weave_ban_list：熔断/冷却中实体清单（CircuitBreaker.snapshot，非 ACTIVE）。 */
  async banList(): Promise<{ bans: BreakerRecord[] }> {
    const breaker = this.#deps.circuitBreaker
    if (!breaker) throw new WeaveError('configuration_error', 'circuitBreaker 未注入')
    return { bans: breaker.snapshot().filter((b) => b.state !== 'ACTIVE') }
  }

  async #updateTask(taskId: string, patch: { status: TaskStatus }): Promise<void> {
    await this.#deps.persistence.tasks.run((db) => {
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(patch.status, new Date().toISOString(), taskId)
    })
  }

  async #loadTask(taskId: string): Promise<TaskRecord> {
    const row = await this.#deps.persistence.tasks.run((db) => {
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRecord | undefined
    })
    if (!row) {
      throw new WeaveError('task_not_found', `任务不存在: ${taskId}`, { taskId })
    }
    return row
  }
}

/* ============================ CLI 层 ============================ */

export interface CliResult {
  /** 人类可读输出（默认）。 */
  text: string
  /** 结构化 JSON（--json 或错误时）。 */
  json: string
  exitCode: number
}

/** 极简参数解析：位置参数与 `--flag value` / `--flag`（--json）。 */
function parseArgs(args: string[]): { positionals: string[]; flags: Map<string, string>; json: boolean } {
  const positionals: string[] = []
  const flags = new Map<string, string>()
  let json = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next)
        i += 1
      } else {
        flags.set(name, '')
      }
      continue
    }
    positionals.push(arg)
  }
  return { positionals, flags, json }
}

const CLI_HELP = `用法: /weave <域> <命令> [参数] [--json]
  team list
  team switch <team_id>
  task submit <描述> --project <id> --version <v> [--team <id>]
  task status --dag <dag_id> | --task <task_id>
  task revise <task_id> <反馈文本>
  task accept <task_id>
  executor list
  dag <dag_id>
  provider add <JSON|紧凑配置>
  provider list
  provider remove <name>`

export type WeaveProviderCliCommand = (args: string[]) => Promise<{
  kind: 'success' | 'error'
  text: string
}>

export class WeaveCli {
  readonly #mcp: WeaveMcp
  readonly #providerCommand?: WeaveProviderCliCommand

  constructor(mcp: WeaveMcp, providerCommand?: WeaveProviderCliCommand) {
    this.#mcp = mcp
    this.#providerCommand = providerCommand
  }

  /**
   * 执行一条 `/weave` 命令（argv 不含首元素）。
   * 成功：text=人类可读，json={ok:true,data}；失败：text=`error: {code}: {message}`，
   * json={ok:false,error:{code,message,details}}，exitCode=1。
   */
  async run(argv: string[]): Promise<CliResult> {
    try {
      const { json, data } = await this.#dispatch(argv)
      return {
        text: json,
        json: JSON.stringify({ ok: true, data }, null, 2),
        exitCode: 0,
      }
    } catch (error) {
      const code = error instanceof WeaveError ? error.code : 'internal_error'
      const message = error instanceof Error ? error.message : String(error)
      const details = error instanceof WeaveError ? error.details : undefined
      return {
        text: `error: ${code}: ${message}`,
        json: JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, null, 2),
        exitCode: 1,
      }
    }
  }

  async #dispatch(argv: string[]): Promise<{ json: string; data: unknown }> {
    const [domain, command, ...rest] = argv
    if (!domain || domain === 'help' || domain === '--help' || domain === '-h') {
      return { json: CLI_HELP, data: null }
    }
    if (domain === 'provider') {
      const args = argv.slice(1)
      const result = await this.#providerCommand?.(args) ?? {
        kind: 'error' as const,
        text: '动态 provider 管理未接入',
      }
      if (result.kind !== 'success') {
        throw new Error(result.text)
      }
      return {
        json: JSON.stringify({ ok: true, result }, null, 2),
        data: result,
      }
    }
    switch (domain) {
      case 'team': {
        if (command === 'list') {
          const data = await this.#mcp.teamList()
          const lines = data.teams.map(
            (t) => `${t.team_id}（${t.name}）${t.default ? ' [默认]' : ''} roles: ${t.roles.join(', ') || '—'}`,
          )
          return { json: lines.length ? lines.join('\n') : '（无可用团队）', data }
        }
        if (command === 'switch') {
          const [teamId] = rest
          if (!teamId) throw new WeaveError('invalid_argument', '用法: /weave team switch <team_id>')
          const data = await this.#mcp.teamSwitch({ team_id: teamId })
          return { json: `已切换会话团队: ${data.team_id}`, data }
        }
        break
      }
      case 'task': {
        if (command === 'submit') {
          const { positionals, flags } = parseArgs(rest)
          const description = positionals[0]
          if (!description) throw new WeaveError('invalid_argument', '用法: /weave task submit <描述> --project <id> --version <v>')
          const data = await this.#mcp.submitTask({
            description,
            project_id: flags.get('project') ?? '',
            version: flags.get('version') ?? '',
            ...(flags.get('team') ? { team_id: flags.get('team') } : {}),
          })
          return { json: `已提交 DAG ${data.dag_id}（任务数 ${data.tasks.length}）`, data }
        }
        if (command === 'status') {
          const { flags } = parseArgs(rest)
          const data = await this.#mcp.getStatus({ dag_id: flags.get('dag'), task_id: flags.get('task') })
          const lines = data.tasks.map((t) => `- ${t.id} [${t.status}] ${t.description}（角色 ${t.assigned_agent ?? '—'}）`)
          return { json: [`DAG: ${data.dag_id ?? '—'}`, ...lines].join('\n'), data }
        }
        if (command === 'revise') {
          const [taskId, ...feedbackParts] = rest
          const feedback = feedbackParts.join(' ')
          const data = await this.#mcp.reviseTask({ task_id: taskId ?? '', feedback })
          return { json: `任务 ${data.task_id} → ${data.status}（第 ${data.revision_count} 次修订）`, data }
        }
        if (command === 'accept') {
          const [taskId] = rest
          const data = await this.#mcp.acceptTask({ task_id: taskId ?? '' })
          return { json: `任务 ${data.task_id} → ${data.status}`, data }
        }
        if (command === 'retry') {
          const [taskId] = rest
          const data = await this.#mcp.taskRetry(taskId ?? '')
          return { json: `任务 ${data.id} → ${data.status}`, data }
        }
        if (command === 'skip') {
          const [taskId] = rest
          const data = await this.#mcp.taskSkip(taskId ?? '')
          return { json: `任务 ${data.id} → ${data.status}（已标记人工跳过）`, data }
        }
        if (command === 'cancel') {
          const [taskId] = rest
          const data = await this.#mcp.taskCancel(taskId ?? '')
          return { json: `任务 ${data.id} → ${data.status}`, data }
        }
        if (command === 'reopen') {
          const [taskId] = rest
          const data = await this.#mcp.taskReopen(taskId ?? '')
          return { json: `任务 ${data.id} → ${data.status}（保温期已重置）`, data }
        }
        break
      }
      case 'knowledge': {
        if (command === 'review') {
          const data = await this.#mcp.knowledgeReview()
          const lines = data.candidates.map((c) => `- ${c.id} [${c.layer}] ${c.title ?? ''}（${c.status}）`)
          return { json: lines.length ? lines.join('\n') : '（无待审核知识）', data }
        }
        if (command === 'approve') {
          const [knowledgeId] = rest
          const data = await this.#mcp.knowledgeApprove(knowledgeId ?? '')
          return { json: `知识 ${data.id} → ${data.status}`, data }
        }
        if (command === 'reject') {
          const [knowledgeId, ...reasonParts] = rest
          const data = await this.#mcp.knowledgeReject(knowledgeId ?? '', reasonParts.join(' '))
          return { json: `知识 ${data.id} → ${data.status}`, data }
        }
        break
      }
      case 'ban': {
        if (command === 'list') {
          const data = await this.#mcp.banList()
          const lines = data.bans.map(
            (b) => `- ${b.scope}/${b.entityKey} [${b.state}] 连续失败=${b.consecutiveFailures} 禁用截至=${b.banExpiresAt ?? '—'} 冷却截至=${b.cooldownEndsAt ?? '—'}`,
          )
          return { json: lines.length ? lines.join('\n') : '（无熔断/冷却中实体）', data }
        }
        break
      }
      case 'executor': {
        if (command === 'list') {
          const data = await this.#mcp.executorList()
          const lines = data.executors.map(
            (e) =>
              `${e.id}（${e.kind}）capabilities: outputSchema=${e.capabilities.outputSchema} depthLimit=${e.capabilities.depthLimit} toolFilter=${e.capabilities.toolFilter} persona=${e.capabilities.persona}`,
          )
          return { json: lines.length ? lines.join('\n') : '（无已注册执行器）', data }
        }
        break
      }
      case 'dag': {
        const dagId = argv[1]
        if (!dagId) throw new WeaveError('invalid_argument', '用法: /weave dag <dag_id>')
        const data = await this.#mcp.getStatus({ dag_id: dagId })
        const lines = data.tasks.map((t) => `- ${t.id} [${t.status}] ${t.description}`)
        return { json: [`DAG ${data.dag_id}（${data.tasks.length} 任务）`, ...lines].join('\n'), data }
      }
      default:
        break
    }
    throw new WeaveError('invalid_argument', `未知命令: /weave ${argv.join(' ')}`)
  }
}
