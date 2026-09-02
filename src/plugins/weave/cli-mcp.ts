import type { DagRepository } from './dag/repository.js'
import type { ExecutorRegistry } from './executor-registry.js'
import type { FeedbackRouter } from './scheduling/feedback-router.js'
import type { KnowledgeReviewService } from './knowledge-review.js'
import type { KnowledgeStore, KnowledgeMeta, KnowledgeFile, KnowledgeLayer, KnowledgeStatus, Visibility } from './knowledge-model.js'
import type { ImportPipeline } from './import-pipeline.js'
import type { WeavePersistence } from './persistence/index.js'
import { TaskStateMachine } from './state/task-state-machine.js'
import type { CircuitBreaker, BreakerRecord } from './safety/circuit-breaker.js'
import type { TaskRecord, TaskStatus } from './state/types.js'
import { WeaveError } from './state/weave-error.js'
import type { TeamManager } from './team/team-manager.js'
import type { TaskStatusNotifier } from './scheduling/task-status-notifier.js'
import type { AuditLog } from './audit/audit-log.js'
import { GraphService, type AffectedFlowsResult, type GraphQueryOptions } from './graph/graph-service.js'
import type {
  DocumentConverter,
  DocumentConvertInput,
  DocumentHistoryItem,
  DocumentPreviewResult,
  DocumentStatusResult,
} from './convert/document-converter.js'
import type { ObsidianService } from './obsidian/obsidian-service.js'
import type { ObsidianCli } from './obsidian/cli.js'

/**
 * P0-CLI-014 —— CLI / MCP 基础（TDD 1.2.x + AC-CLI）。
 *
 * 交付：
 * - `WeaveMcp`：MCP Tool 层——weave_get_status / weave_revise_task /
 *   weave_accept_task / weave_team_list / weave_team_switch /
 *   weave_executor_list + 知识审核/任务运维/禁令；全部返回结构化 JSON 数据。
 *   任务下发不在此层——唯一入口是对话中的 weave_plan_tasks（队长模式，planner.ts）；
 * - `WeaveCli`：`/weave` 斜杠命令解析器——team list/switch、task status/revise/
 *   accept/retry/skip/cancel/reopen、executor list、dag <id>、provider 管理；
 *   默认人类可读文本，`--json` 输出结构化 JSON；
 * - 错误可读：WeaveError(code) → `error: {code}: {message}`（文本）/ {ok:false,error}（JSON）。
 *
 * 复用（依赖注入）：TeamManager（团队加载/校验/会话绑定）、ExecutorRegistry（执行器
 * 列表与校验）、FeedbackRouter（修订/确认）、DagRepository（DAG 查询/取消）、
 * TaskStateMachine（状态机校验）、WeavePersistence（tasks/dags/edges）。
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
  /** AnyDoc 导入管线：knowledge/import/* RPC 用。 */
  importPipeline?: ImportPipeline
  /** 熔断器（P0-SAFETY-015，t8）：ban list 用。 */
  circuitBreaker?: CircuitBreaker
  /**
   * 任务状态变更通知单出口（doc/05 §6.4 P1-D 接线点 3）：CLI/MCP 治理动作发电，
   * actor=captain——回声抑制（echoSelfActions=false）下缺省不通知（发起者已知结果）。
   */
  statusNotifier?: TaskStatusNotifier
  /**
   * 审计（doc/05 §6.4）：治理发电点同步补 task.status_changed（by=captain）；
   * 与通知同位置、逐条容错（审计失败不影响治理动作）。
   */
  audit?: AuditLog
  /**
   * Graphify 图谱服务（doc/09 §2.4）：weave_graph_* 工具与 /weave graph CLI 使用。
   * 未注入时对应入口返回 configuration_error（纯 CLI 可显式注入本地项目根）。
   */
  graphService?: GraphService
  /**
   * AnyDoc 独立文档转换服务（doc/08 §7 / doc/09 §2.1，T6）：
   * document convert/preview/status 与 weave_document_convert 使用。
   * 未注入时对应入口返回 configuration_error（不依赖知识导入/团队）。
   */
  documentConverter?: DocumentConverter
  /**
   * Obsidian 真实 Vault 集成服务（doc/09 §2.1，T3）：
   * obsidian generate/open/reindex/status 与 weave_obsidian_* 使用。
   * 未注入时对应入口返回 configuration_error。
   */
  obsidianService?: ObsidianService
  /**
   * 运行时执行联动（index.ts 在调度器就绪后注入）：
   * cancelTask → 中止运行中的子代理；resumeTask → 重试后重新泵 DAG。
   * 钩子内部异常由 scheduler 自行收敛；此处调用不得失败任务动作本身。
   */
  executionHooks?: {
    cancelTask?: (taskId: string) => void | Promise<void>
    resumeTask?: (taskId: string) => void | Promise<void>
  }
}

/* ============================ MCP Tool 层 ============================ */

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

  /** weave_knowledge_search：执行器/DSH 子代理按需检索 active 知识（R7 执行器按需检索）。 */
  async knowledgeSearch(
    input: { query?: string; project_id?: string; version?: string; role_id?: string; instance_id?: string; layer?: string; visibility?: string; limit?: number } = {},
  ): Promise<{ query: string; total_hits: number; results: Array<{ id: string; title: string; path: string; layer: string; status: string; visibility: string; freshness_score: number; content: string }> }> {
    const store = this.#deps.knowledgeStore
    if (!store) throw new WeaveError('configuration_error', 'knowledgeStore 未注入（knowledge_search 需要 KnowledgeStore）')
    const query = String(input.query ?? '').trim().toLowerCase()
    if (query === '') throw new WeaveError('invalid_argument', 'query 不能为空', { field: 'query' })
    const limit = Math.max(1, Math.min(20, Number(input.limit ?? 5) || 5))
    const layer = input.layer && input.layer !== '' ? input.layer as KnowledgeLayer : undefined
    const visibility = input.visibility && input.visibility !== '' ? input.visibility as Visibility : undefined
    const metas = await store.listMeta({ status: 'active', ...(layer ? { layer } : {}) })
    const scored: Array<{ meta: KnowledgeMeta; score: number; file: KnowledgeFile }> = []
    let totalChars = 0
    for (const meta of metas) {
      const file = store.getKnowledgeFile(meta.id)
      if (!file) continue
      if (visibility !== undefined && file.frontmatter.visibility !== visibility) continue
      const path = meta.path.toLowerCase()
      if (input.project_id !== undefined && !path.includes(String(input.project_id).toLowerCase())) continue
      if (input.version !== undefined && !path.includes(String(input.version).toLowerCase())) continue
      if (input.role_id !== undefined && !path.includes(String(input.role_id).toLowerCase())) continue
      if (input.instance_id !== undefined && !path.includes(String(input.instance_id).toLowerCase())) continue
      const title = file.frontmatter.title.toLowerCase()
      const body = file.body.toLowerCase()
      let score = 0
      if (title.includes(query)) score += 5
      if (body.includes(query)) score += 1
      if (path.includes(query)) score += 2
      if (score === 0) continue
      scored.push({ meta, score, file })
    }
    scored.sort((a, b) => b.score - a.score || b.meta.freshness_score - a.meta.freshness_score)
    const results: Array<{ id: string; title: string; path: string; layer: string; status: string; visibility: string; freshness_score: number; content: string }> = []
    for (const item of scored.slice(0, limit)) {
      const content = item.file.body
      const clamped = totalChars + content.length > 2500 ? content.slice(0, Math.max(0, 2500 - totalChars)) : content
      totalChars += clamped.length
      results.push({
        id: item.meta.id,
        title: item.file.frontmatter.title,
        path: item.meta.path,
        layer: item.meta.layer,
        status: item.meta.status,
        visibility: item.file.frontmatter.visibility,
        freshness_score: item.meta.freshness_score,
        content: clamped,
      })
      if (totalChars >= 2500) break
    }
    return { query: String(input.query ?? ''), total_hits: scored.length, results }
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
    // 接线点 3（doc/05 §6.4）：CLI/MCP 治理发电，actor=captain（缺省回声抑制不通知）。
    this.#deps.statusNotifier?.notify({
      taskId,
      dagId: String((task as { dag_id?: string }).dag_id ?? ""),
      sessionId: task.session_id ?? '',
      subject: task.description.split('\n')[0]?.trim() || taskId,
      from: task.status,
      to: 'WAITING',
      actor: 'captain',
      source: 'task_retry',
    })
    await this.#auditStatus(task, task.status, 'WAITING', 'captain')
    try {
      await this.#deps.executionHooks?.resumeTask?.(taskId)
    } catch {
      // 联动失败不影响重试动作本身（DAG 可由后续动作恢复）
    }
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
    // 接线点 3（doc/05 §6.4）：跳过发电，actor=captain（缺省回声抑制不通知）。
    this.#deps.statusNotifier?.notify({
      taskId,
      dagId: String((task as { dag_id?: string }).dag_id ?? ""),
      sessionId: task.session_id ?? '',
      subject: task.description.split('\n')[0]?.trim() || taskId,
      from: task.status,
      to: 'SKIPPED',
      actor: 'captain',
      source: 'task_skip',
    })
    await this.#auditStatus(task, task.status, 'SKIPPED', 'captain')
    return this.#loadTask(taskId)
  }

  /** weave_task_cancel：任务取消（复用 DagRepository.cancelTask，含下游 SKIPPED 传播）。 */
  async taskCancel(taskId: string): Promise<TaskRecord> {
    const { dag_id: dagId } = (await this.#deps.persistence.tasks.run((db) => {
      return db.prepare('SELECT dag_id FROM tasks WHERE id = ?').get(taskId) as { dag_id: string } | undefined
    })) ?? { dag_id: '' }
    if (dagId) {
      const dag = await this.#deps.dagRepository.cancelTask(dagId, taskId)
      try {
        await this.#deps.executionHooks?.cancelTask?.(taskId)
      } catch {
        // 联动失败不影响取消动作本身（子代理由超时兜底）
      }
      const updated = dag.tasks.find((t) => t.id === taskId)
      if (!updated) throw new WeaveError('task_not_found', `任务不存在: ${taskId}`, { taskId })
      return updated
    }
    // 兼容无 dag_id 的早期行：状态机直移 + 更新
    const task = await this.#loadTask(taskId)
    void TaskStateMachine.transition(task.status, 'CANCELLED')
    await this.#updateTask(taskId, { status: 'CANCELLED' })
    // 接线点 3（doc/05 §6.4）：无 dag 兼容路径同样发电，actor=captain。
    this.#deps.statusNotifier?.notify({
      taskId,
      dagId: String((task as { dag_id?: string }).dag_id ?? ""),
      sessionId: task.session_id ?? '',
      subject: task.description.split('\n')[0]?.trim() || taskId,
      from: task.status,
      to: 'CANCELLED',
      actor: 'captain',
      source: 'task_cancel',
    })
    await this.#auditStatus(task, task.status, 'CANCELLED', 'captain')
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

  /* ------------------- 图谱工具（doc/09 §2.4，T2） ------------------- */

  /** weave_graph_build：构建/更新代码图谱与执行流（Graphify extract + flows build）。 */
  async graphBuild(input: { projectRoot?: string; sourceDir?: string } = {}): Promise<{ graphPath: string; flowsPath: string }> {
    if (input.projectRoot || input.sourceDir) {
      const graph = new GraphService({
        projectRoot: input.projectRoot || process.cwd(),
        ...(input.sourceDir ? { sourceDir: input.sourceDir } : {}),
      })
      return graph.build()
    }
    return this.#requireGraph().build()
  }

  /** weave_graph_query：代码图谱语义查询。 */
  async graphQuery(input: { question: string; budget?: number; dfs?: boolean }): Promise<{ question: string; result: string }> {
    const question = typeof input.question === 'string' ? input.question.trim() : ''
    if (question === '') {
      throw new WeaveError('invalid_argument', 'question 不能为空', { field: 'question' })
    }
    const options: GraphQueryOptions = {}
    if (input.budget !== undefined) options.budget = input.budget
    if (input.dfs !== undefined) options.dfs = input.dfs
    return { question, result: await this.#requireGraph().query(question, options) }
  }

  /** weave_graph_path：两个节点之间的最短路径。 */
  async graphPath(input: { source: string; target: string }): Promise<{ source: string; target: string; path: string }> {
    const source = typeof input.source === 'string' ? input.source.trim() : ''
    const target = typeof input.target === 'string' ? input.target.trim() : ''
    if (source === '' || target === '') {
      throw new WeaveError('invalid_argument', 'source 与 target 不能为空', { source, target })
    }
    return { source, target, path: await this.#requireGraph().path(source, target) }
  }

  /** weave_graph_explain：单节点详情/解释。 */
  async graphExplain(input: { node: string }): Promise<{ node: string; explain: string }> {
    const node = typeof input.node === 'string' ? input.node.trim() : ''
    if (node === '') {
      throw new WeaveError('invalid_argument', 'node 不能为空', { field: 'node' })
    }
    return { node, explain: await this.#requireGraph().explain(node) }
  }

  /** weave_graph_affected：改动文件 → 影响面（执行流）。 */
  async graphAffected(input: { files: string[] }): Promise<AffectedFlowsResult> {
    const rawFiles = input.files
    if (!Array.isArray(rawFiles)) {
      throw new WeaveError('invalid_argument', 'files 必须为字符串数组', { field: 'files' })
    }
    const files: string[] = []
    for (let i = 0; i < rawFiles.length; i += 1) {
      const file = rawFiles[i]
      if (typeof file !== 'string' || file.trim() === '') {
        throw new WeaveError('invalid_argument', `files[${i}] 必须为非空字符串`, { field: 'files', index: i })
      }
      files.push(file.trim())
    }
    return this.#requireGraph().affectedFlows(files)
  }

  /* ------------------- 文档转换（doc/08 §7 / doc/09 §2.1，T6） ------------------- */

  /**
   * weave_document_convert：独立文档转换（CLI/MCP 使用最终结果）。
   * base64 上传模式传 filename+data；服务端路径模式传 file。
   */
  async documentConvert(input: DocumentConvertInput): Promise<{
    jobId: string
    status: string
    filename: string
    title?: string
    markdown?: string
    warnings: string[]
    error?: string
  }> {
    const job = await this.#requireDocumentConverter().convertAndWait(input)
    return {
      jobId: job.id,
      status: job.status,
      filename: job.filename,
      ...(job.title !== undefined ? { title: job.title } : {}),
      ...(job.markdown !== undefined ? { markdown: job.markdown } : {}),
      warnings: job.warnings,
      ...(job.error !== undefined ? { error: job.error } : {}),
    }
  }

  /** weave_document_status：查询独立转换任务状态。 */
  async documentStatus(jobId: string): Promise<DocumentStatusResult> {
    return this.#requireDocumentConverter().status(jobId)
  }

  /** weave_document_preview：读取已完成转换的 Markdown。 */
  async documentPreview(jobId: string): Promise<DocumentPreviewResult> {
    return this.#requireDocumentConverter().preview(jobId)
  }

  /** weave_document_history：最近独立转换记录（可选入口）。 */
  async documentHistory(limit = 20): Promise<DocumentHistoryItem[]> {
    return this.#requireDocumentConverter().history(limit)
  }

  /* ------------------- Obsidian（doc/09 §2.1，T3） ------------------- */

  /** weave_obsidian_generate：生成/刷新 Obsidian Vault（增量 + 冲突保护）。 */
  async obsidianGenerate(input: { vaultPath?: string; force?: boolean } = {}): Promise<unknown> {
    return this.#requireObsidian().generate(input)
  }

  /** weave_obsidian_open：返回 Obsidian 打开协议 URI。 */
  async obsidianOpen(input: { vaultPath?: string } = {}): Promise<unknown> {
    return this.#requireObsidian().open(input)
  }

  /** weave_obsidian_reindex：手动扫描 Vault Markdown 并重建指纹。 */
  async obsidianReindex(input: { vaultPath?: string } = {}): Promise<unknown> {
    return this.#requireObsidian().reindex(input)
  }

  /** weave_obsidian_status：Vault 状态摘要。 */
  async obsidianStatus(input: { vaultPath?: string } = {}): Promise<unknown> {
    return this.#requireObsidian().status(input)
  }

  /** weave_obsidian_conflicts：冲突清单（辅助工具）。 */
  async obsidianConflicts(input: { vaultPath?: string } = {}): Promise<unknown> {
    return this.#requireObsidian().conflicts(input)
  }

  #requireObsidian(): ObsidianService {
    const service = this.#deps.obsidianService
    if (!service) {
      throw new WeaveError('configuration_error', 'obsidianService 未注入（weave_obsidian_* 需要 ObsidianService）')
    }
    return service
  }

  #requireDocumentConverter(): DocumentConverter {
    const converter = this.#deps.documentConverter
    if (!converter) {
      throw new WeaveError('configuration_error', 'documentConverter 未注入（document/* 需要 DocumentConverter）')
    }
    return converter
  }

  #requireGraph(): GraphService {
    const graph = this.#deps.graphService
    if (!graph) throw new WeaveError('configuration_error', 'graphService 未注入（weave_graph_* 需要 GraphService）')
    return graph
  }

  async #updateTask(taskId: string, patch: { status: TaskStatus }): Promise<void> {
    await this.#deps.persistence.tasks.run((db) => {
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(patch.status, new Date().toISOString(), taskId)
    })
  }

  /** 接线点 3 审计（doc/05 §6.4）：与通知同位置补 task.status_changed（by=captain）；失败容错不阻断。 */
  async #auditStatus(task: TaskRecord, from: TaskStatus, to: TaskStatus, by: string): Promise<void> {
    try {
      await this.#deps.audit?.record({ type: 'task.status_changed', task_id: task.id, from, to, by })
    } catch {
      // 审计失败不影响治理动作本身（与通知吞错同 philosophy）。
    }
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
  task status --dag <dag_id> | --task <task_id>
  task revise <task_id> <反馈文本>
  task accept <task_id>
  executor list
  dag <dag_id>
  provider add <JSON|JSON数组|YAML|文件路径|紧凑配置>
  provider list
  provider remove <name>
  graph build
  graph query <问题> [--budget N] [--dfs]
  graph path <source> <target>
  graph explain <node>
  graph affected <file> [file...]
  document convert <file>
  document status <job_id>
  document preview <job_id>
  document history [--limit N]
  obsidian generate [--vault <path>] [--force]
  obsidian open [--vault <path>]
  obsidian reindex [--vault <path>]
  obsidian status [--vault <path>]
  obsidian conflicts [--vault <path>]

任务下发已收敛为对话式：在会话中描述目标，队长模型调用 weave_plan_tasks 拆解派发。`

export type WeaveProviderCliCommand = (args: string[]) => Promise<{
  kind: 'success' | 'error'
  text: string
}>

export class WeaveCli {
  readonly #mcp: WeaveMcp
  readonly #providerCommand?: WeaveProviderCliCommand
  readonly #obsidianCli?: ObsidianCli

  constructor(mcp: WeaveMcp, providerCommand?: WeaveProviderCliCommand, obsidianCli?: ObsidianCli) {
    this.#mcp = mcp
    this.#providerCommand = providerCommand
    this.#obsidianCli = obsidianCli
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
        if (command === 'search') {
          const [query, ...extra] = rest
          const flags = new Map<string, string>()
          for (let i = 0; i < extra.length; i += 1) {
            const token = extra[i]!
            if (token.startsWith('--')) {
              const value = extra[i + 1]
              if (value !== undefined && !value.startsWith('--')) { flags.set(token.slice(2), value); i += 1 }
            }
          }
          const data = await this.#mcp.knowledgeSearch({
            query,
            ...(flags.get('project') ? { project_id: flags.get('project') } : {}),
            ...(flags.get('version') ? { version: flags.get('version') } : {}),
            ...(flags.get('role') ? { role_id: flags.get('role') } : {}),
            ...(flags.get('limit') ? { limit: Number(flags.get('limit')) } : {}),
          })
          const lines = data.results.map((r) => `- [${r.layer}] ${r.title}（${r.id}）${r.content.slice(0, 120)}`)
          return { json: lines.length ? `${data.total_hits} 条命中，展示 ${data.results.length} 条：\n${lines.join('\n')}` : '（无匹配知识）', data }
        }
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
      case 'code': {
        if (command === 'build') {
          const [projectRoot, sourceDir] = rest
          const data = await this.#mcp.graphBuild({ projectRoot, sourceDir })
          return { json: `代码图谱已构建: ${data.graphPath}
执行流: ${data.flowsPath}`, data }
        }
        break
      }
      case 'graph': {
        if (command === 'build') {
          const data = await this.#mcp.graphBuild()
          return { json: `图谱已构建: ${data.graphPath}\n执行流: ${data.flowsPath}`, data }
        }
        if (command === 'query') {
          const { positionals, flags } = parseArgs(rest)
          if (positionals.length === 0) {
            throw new WeaveError('invalid_argument', '用法: /weave graph query <问题> [--budget N] [--dfs]')
          }
          const data = await this.#mcp.graphQuery({
            question: positionals.join(' '),
            ...(flags.has('budget') ? { budget: Number(flags.get('budget')) } : {}),
            ...(flags.has('dfs') ? { dfs: true } : {}),
          })
          return { json: data.result || '（无查询结果）', data }
        }
        if (command === 'path') {
          const { positionals } = parseArgs(rest)
          const [source, target] = positionals
          if (!source || !target) {
            throw new WeaveError('invalid_argument', '用法: /weave graph path <source> <target>')
          }
          const data = await this.#mcp.graphPath({ source, target })
          return { json: data.path || '（无路径）', data }
        }
        if (command === 'explain') {
          const { positionals } = parseArgs(rest)
          const [node] = positionals
          if (!node) {
            throw new WeaveError('invalid_argument', '用法: /weave graph explain <node>')
          }
          const data = await this.#mcp.graphExplain({ node })
          return { json: data.explain || '（无解释）', data }
        }
        if (command === 'affected') {
          const { positionals: files } = parseArgs(rest)
          if (files.length === 0) {
            throw new WeaveError('invalid_argument', '用法: /weave graph affected <file1> [file2 ...]')
          }
          const data = await this.#mcp.graphAffected({ files })
          const result = data
          const lines = [
            `改动文件 ${result.changedFiles.length} 个，命中节点 ${result.matchedNodeIds.length} 个，影响执行流 ${result.affectedFlows.length} 条`,
            ...result.affectedFlows.map((f) => `- [${f.id}] ${f.name}（${f.files.length} 文件，深度 ${f.depth}）`),
          ]
          return { json: lines.join('\n'), data }
        }
        break
      }
      case 'document': {
        if (command === 'convert') {
          const { positionals } = parseArgs(rest)
          const file = positionals[0]
          if (!file) {
            throw new WeaveError('invalid_argument', '用法: /weave document convert <file>')
          }
          const data = await this.#mcp.documentConvert({ file })
          if (data.status === 'failed') {
            throw new WeaveError('conversion_failed', `文档转换失败: ${data.error ?? '未知错误'}`, { jobId: data.jobId })
          }
          const markdown = data.markdown ?? ''
          const snippet = markdown.length > 200 ? `${markdown.slice(0, 200)}…` : markdown
          return {
            json: `转换完成: ${data.jobId} [${data.status}] ${data.title ?? data.filename}\n${snippet}`,
            data,
          }
        }
        if (command === 'status') {
          const [jobId] = rest
          if (!jobId) throw new WeaveError('invalid_argument', '用法: /weave document status <job_id>')
          const data = await this.#mcp.documentStatus(jobId)
          const lines = [
            `- ${data.jobId} [${data.status}] ${data.filename}`,
            ...(data.title ? [`  标题: ${data.title}`] : []),
            ...(data.progress !== undefined ? [`  进度: ${data.progress}`] : []),
            ...(data.error ? [`  错误: ${data.error}`] : []),
            ...(data.warnings.length ? [`  警告: ${data.warnings.join('; ')}`] : []),
          ]
          return { json: lines.join('\n'), data }
        }
        if (command === 'preview') {
          const [jobId] = rest
          if (!jobId) throw new WeaveError('invalid_argument', '用法: /weave document preview <job_id>')
          const data = await this.#mcp.documentPreview(jobId)
          return { json: data.markdown, data }
        }
        if (command === 'history') {
          const { flags } = parseArgs(rest)
          const limit = flags.has('limit') ? Number(flags.get('limit')) : undefined
          const items = await this.#mcp.documentHistory(limit && Number.isFinite(limit) ? limit : 20)
          const lines = items.map((item) => `- ${item.jobId} [${item.status}] ${item.filename} ${item.title ?? ''}`.trimEnd())
          return { json: lines.length ? lines.join('\n') : '（暂无文档转换记录）', data: items }
        }
        break
      }
      case 'obsidian': {
        if (!this.#obsidianCli) {
          throw new WeaveError('configuration_error', 'obsidianService 未注入（/weave obsidian 不可用）')
        }
        const result = await this.#obsidianCli.run(command === undefined ? rest : [command, ...rest])
        return { json: result.text, data: result.data }
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
