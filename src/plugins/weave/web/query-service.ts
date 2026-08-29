import { AUDIT_EVENT_TYPES, DEFAULT_AUDIT_DIR, AuditLog, type AuditEventType, type AuditQuery } from '../audit/audit-log.js'
import { WeaveMcp, type CliMcpDeps } from '../cli-mcp.js'
import { DagRepository } from '../dag/repository.js'
import type { WeavePersistence } from '../persistence/persistence.js'
import { TEAM_BINDINGS_TABLE_DDL } from '../persistence/schemas.js'
import { SessionTracker } from '../session-tracker.js'
import { TASK_STATUSES, type TaskRecord, type TaskStatus } from '../state/types.js'
import { WeaveError } from '../state/weave-error.js'
import { KnowledgeStore, type KnowledgeLayer, type KnowledgeStatus } from '../knowledge-model.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ImportPipeline, type ImportMeta, type KnowledgeCandidate } from '../import-pipeline.js'
import type { TeamManager } from '../team-manager.js'
import type { WeaveScheduler } from '../scheduler.js'
import { buildKnowledgeGraph } from './knowledge-graph.js'

/**
 * Web 真实数据查询/操作服务（t2）——供 RPC 层（rpc.ts 由 weave-dev-api 接线）调用的
 * 任务、知识库、审计、会话四域能力。全部读写真实持久化层：
 * - 任务列表/DAG 详情：tasks.db（tasks/dags/edges 表）；任务按会话过滤（session_id）；
 * - 任务动作：复用 WeaveMcp（revise / accept / retry / skip / cancel / reopen）；
 *   任务下发不在本层——唯一入口是会话内的 weave_plan_tasks（队长模式，planner.ts）；
 * - 知识：复用 WeaveMcp.knowledgeReview / approve / reject（candidate 队列 + 元数据状态查询）；
 * - 审计：AuditLog.query（JSONL 追加日志，无 fake 数据路径）；
 * - 会话绑定：core.db team_bindings 直读；set/clear 复用 TeamManager 现有方法；
 * - 会话状态：WeaveScheduler.memberRuntime（成员实时占用）+ 最近 DAG 派生最近结果；
 * - 修订记录：SessionTracker.listRevisions（feedback.db revision_records，最近优先）。
 *
 * 本文件只提供服务方法与 endpoint 分发器；不做任何数据伪造，
 * 缺失依赖时抛 configuration_error 而非返回空数据。
 */

/* ------------------------------ 入参归一化与校验 ------------------------------ */

type Payload = Record<string, unknown>

/** RPC 入参必须是普通对象（与 rpc.ts objectPayload 同约定）。 */
function asPayload(input: unknown): Payload {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new WeaveError('invalid_argument', '入参必须是 JSON 对象')
  }
  return input as Payload
}

/** 可选字符串字段（多别名兼容 camelCase/snake_case；空串视为未提供）。 */
function optionalString(input: Payload, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string') {
      throw new WeaveError('invalid_argument', `${key} 必须为字符串`, { field: key })
    }
    return value
  }
  return undefined
}

function requireString(input: Payload, ...keys: string[]): string {
  const value = optionalString(input, ...keys)
  if (value === undefined) {
    throw new WeaveError('invalid_argument', `缺少必填字段: ${keys.join(' / ')}`, { fields: keys })
  }
  return value
}

function optionalPositiveInt(input: Payload, key: string): number | undefined {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new WeaveError('invalid_argument', `${key} 必须为正整数`, { field: key, value })
  }
  return value
}

function enumOrThrow<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new WeaveError('invalid_argument', `不支持的${label}: ${value}`, { value, allowed })
  }
  return value as T
}

/** tasks 行 → TaskRecord（dependencies 反序列化、skip_override 布尔化）。 */
interface TaskRowLike {
  dependencies: string | null
  skip_override: number | null
  [key: string]: unknown
}

function rowToTask(row: TaskRowLike): TaskRecord {
  let dependencies: string[] = []
  try {
    const parsed = JSON.parse(String(row.dependencies ?? '[]')) as unknown
    if (Array.isArray(parsed)) dependencies = parsed as string[]
  } catch {
    dependencies = []
  }
  return { ...(row as unknown as Omit<TaskRecord, 'dependencies' | 'skip_override'>), dependencies, skip_override: row.skip_override === 1 }
}

/** 成员状态徽标用小写状态（idle/running/completed/failed/...）。 */
function statusLabel(status: TaskStatus): string {
  return status.toLowerCase()
}

function subjectOf(description: string): string {
  const firstLine = String(description ?? '').split('\n')[0]?.trim() ?? ''
  return firstLine.slice(0, 60)
}

export interface QueryServiceDeps {
  /** 五库持久化句柄（tasks/core/feedback/knowledgeMeta/imports）。 */
  persistence: WeavePersistence
  /** MCP 层：task/action、knowledge/* 复用；缺省时相应端点 configuration_error。 */
  mcp?: WeaveMcp
  /** 审计日志：audit/list 用。 */
  auditLog?: AuditLog
  /** 修订上下文：session/revisions 用。 */
  sessionTracker?: SessionTracker
  /** 团队管理：session/set-binding、clear-binding 复用现有绑定方法。 */
  teamManager?: TeamManager
  /** 队长调度器：session/status 的成员实时占用数据源。 */
  scheduler?: WeaveScheduler
  /** 知识仓库：knowledge/graph 只读真实知识文件与 [[双链]]。 */
  knowledgeStore?: KnowledgeStore
  /** AnyDoc 导入管线：knowledge/import/* RPC 用。 */
  importPipeline?: ImportPipeline
}

const KNOWLEDGE_STATUSES = ['candidate', 'active', 'deprecated', 'superseded'] as const
const KNOWLEDGE_LAYERS = ['project', 'role', 'instance', 'shared'] as const
const TASK_ACTIONS = ['revise', 'accept', 'retry', 'skip', 'cancel', 'reopen'] as const

export class WeaveQueryService {
  private readonly persistence: WeavePersistence
  private readonly mcp?: WeaveMcp
  private readonly auditLog?: AuditLog
  private readonly sessionTracker?: SessionTracker
  private readonly teamManager?: TeamManager
  private readonly scheduler?: WeaveScheduler
  private readonly knowledgeStore?: KnowledgeStore
  private readonly importPipeline?: ImportPipeline
  private readonly dagRepository: DagRepository

  constructor(deps: QueryServiceDeps) {
    this.persistence = deps.persistence
    this.mcp = deps.mcp
    this.auditLog = deps.auditLog
    this.sessionTracker = deps.sessionTracker
    this.teamManager = deps.teamManager
    this.scheduler = deps.scheduler
    this.knowledgeStore = deps.knowledgeStore
    this.importPipeline = deps.importPipeline
    this.dagRepository = new DagRepository(deps.persistence)
  }

  /* --------------------------------- 任务域 --------------------------------- */

  /**
   * task/list：分页 + 过滤（teamId/projectId/status/search），updated_at 降序。
   * 分页两种形态二选一：page(+pageSize 默认 20) 或 limit(默认 50)+offset(默认 0)，混用报错。
   * search 对 description/id 做 LIKE 包含匹配（%/_/\ 转义）。
   * 回退：未传 sessionId 且显式传 teamId 时按 team_id 维度返回该团队最近活跃任务
   * （响应带 fallback_used:true）——供「会话 id 与落库不一致」时期待面板兜底取数。
   */
  async taskList(input: unknown): Promise<{ total: number; tasks: TaskRecord[]; fallback_used?: boolean }> {
    const p = asPayload(input)
    const page = optionalPositiveInt(p, 'page')
    const pageSizeRaw = optionalPositiveInt(p, 'pageSize')
    const limitRaw = optionalPositiveInt(p, 'limit')
    const offsetRaw = p['offset']
    let limit: number
    let offset: number
    if (page !== undefined) {
      if (limitRaw !== undefined || offsetRaw !== undefined) {
        throw new WeaveError('invalid_argument', '分页参数冲突：page 与 limit/offset 不可混用')
      }
      const pageSize = pageSizeRaw ?? 20
      limit = pageSize
      offset = (page - 1) * pageSize
    } else {
      if (pageSizeRaw !== undefined) {
        throw new WeaveError('invalid_argument', '分页参数冲突：pageSize 必须与 page 搭配使用')
      }
      limit = limitRaw ?? 50
      if (offsetRaw !== undefined) {
        if (typeof offsetRaw !== 'number' || !Number.isInteger(offsetRaw) || offsetRaw < 0) {
          throw new WeaveError('invalid_argument', 'offset 必须为非负整数', { value: offsetRaw })
        }
        offset = offsetRaw
      } else {
        offset = 0
      }
    }

    const where: string[] = []
    const params: string[] = []
    const sessionId = optionalString(p, 'sessionId', 'session_id')
    if (sessionId !== undefined) {
      where.push('session_id = ?')
      params.push(sessionId)
    }
    const teamId = optionalString(p, 'teamId', 'team_id')
    if (teamId !== undefined) {
      where.push('team_id = ?')
      params.push(teamId)
    }
    const projectId = optionalString(p, 'projectId', 'project_id')
    if (projectId !== undefined) {
      where.push('project_id = ?')
      params.push(projectId)
    }
    const status = optionalString(p, 'status')
    if (status !== undefined) {
      enumOrThrow(status, TASK_STATUSES, '任务状态')
      where.push('status = ?')
      params.push(status)
    }
    const search = optionalString(p, 'search')
    if (search !== undefined) {
      const escaped = search.replace(/([\\%_])/g, '\\$1')
      where.push("(description LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')")
      params.push(`%${escaped}%`, `%${escaped}%`)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    // 回退标记：仅在「无 sessionId 过滤 + 显式 teamId」时为 true（§REDESIGN C 兜底语义）。
    const teamFallbackUsed = sessionId === undefined && teamId !== undefined

    return this.persistence.tasks.run((db) => {
      const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM tasks ${whereSql}`).get(...params) as
        | { total: number | bigint }
        | undefined
      const rows = db
        .prepare(
          `SELECT * FROM tasks ${whereSql}
           ORDER BY updated_at DESC, id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as unknown as TaskRowLike[]
      return {
        total: Number(totalRow?.total ?? 0),
        tasks: rows.map(rowToTask),
        ...(teamFallbackUsed ? { fallback_used: true } : {}),
      }
    })
  }

  /**
   * task/get：按 dagId 或 taskId 返回 DAG（含 tasks 与 edges）。
   * 两键至少其一；taskId 优先解析其所属 DAG（早期无 dag_id 的行降级为单任务视图）。
   */
  async taskGet(input: unknown): Promise<{ dag_id: string; tasks: TaskRecord[]; edges: Array<{ from: string; to: string }>; status: string }> {
    const p = asPayload(input)
    const dagId = optionalString(p, 'dagId', 'dag_id')
    const taskId = optionalString(p, 'taskId', 'task_id')
    if (!dagId && !taskId) {
      throw new WeaveError('invalid_argument', 'dagId 与 taskId 至少提供一个')
    }
    if (dagId) {
      return this.dagRepository.loadDag(dagId)
    }
    if (!taskId) {
      // 走到这里说明 dagId 为空；无 taskId 则前面已报“至少提供一个”，此处兜底窄化类型。
      throw new WeaveError('invalid_argument', 'dagId 与 taskId 至少提供一个')
    }
    const row = await this.persistence.tasks.run((db) => {
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRowLike | undefined
    })
    if (!row) {
      throw new WeaveError('task_not_found', `任务不存在: ${taskId}`, { taskId })
    }
    const task = rowToTask(row)
    const rowDagId = typeof row['dag_id'] === 'string' ? (row['dag_id'] as string) : ''
    if (rowDagId !== '') {
      return this.dagRepository.loadDag(rowDagId)
    }
    return { dag_id: '', tasks: [task], edges: [], status: 'created' }
  }

  /** task/action：revise/accept/retry/skip/cancel/reopen 全部转发 WeaveMcp 现有实现。 */
  async taskAction(input: unknown): Promise<unknown> {
    if (!this.mcp) {
      throw new WeaveError('configuration_error', 'mcp 未注入（task/action 需要 WeaveMcp）')
    }
    const p = asPayload(input)
    const action = enumOrThrow(requireString(p, 'action'), TASK_ACTIONS, '任务动作')
    const taskId = requireString(p, 'taskId', 'task_id')
    const feedback = optionalString(p, 'feedback')
    switch (action) {
      case 'revise':
        return this.mcp.reviseTask({ task_id: taskId, feedback: feedback ?? '' })
      case 'accept':
        return this.mcp.acceptTask({ task_id: taskId })
      case 'retry':
        return this.mcp.taskRetry(taskId)
      case 'skip':
        return this.mcp.taskSkip(taskId)
      case 'cancel':
        return this.mcp.taskCancel(taskId)
      case 'reopen':
        return this.mcp.taskReopen(taskId)
    }
  }

  /* --------------------------------- 知识域 --------------------------------- */

  /** knowledge/list：status（默认 candidate）/layer/limit，转发 WeaveMcp.knowledgeReview。 */
  async knowledgeList(input: unknown): Promise<unknown> {
    if (!this.mcp) {
      throw new WeaveError('configuration_error', 'mcp 未注入（knowledge/list 需要 WeaveMcp）')
    }
    const p = asPayload(input)
    const status = enumOrThrow(optionalString(p, 'status') ?? 'candidate', KNOWLEDGE_STATUSES, '知识状态')
    const layerValue = optionalString(p, 'layer')
    const layer = layerValue !== undefined ? enumOrThrow(layerValue, KNOWLEDGE_LAYERS, '知识层级') : undefined
    const limit = optionalPositiveInt(p, 'limit') ?? 50
    return this.mcp.knowledgeReview({ status, ...(layer ? { layer } : {}), limit })
  }

  /** knowledge/approve：candidate → active（WeaveMcp → KnowledgeReviewService）。 */
  async knowledgeApprove(input: unknown): Promise<unknown> {
    if (!this.mcp) {
      throw new WeaveError('configuration_error', 'mcp 未注入（knowledge/approve 需要 WeaveMcp）')
    }
    const p = asPayload(input)
    return this.mcp.knowledgeApprove(requireString(p, 'id', 'knowledgeId', 'knowledge_id'))
  }

  /** knowledge/reject：candidate → deprecated。 */
  async knowledgeReject(input: unknown): Promise<unknown> {
    if (!this.mcp) {
      throw new WeaveError('configuration_error', 'mcp 未注入（knowledge/reject 需要 WeaveMcp）')
    }
    const p = asPayload(input)
    const id = requireString(p, 'id', 'knowledgeId', 'knowledge_id')
    const reason = optionalString(p, 'reason')
    return this.mcp.knowledgeReject(id, reason)
  }

  /** knowledge/graph：读取真实知识文件；轻量双链图，完整 Graphify 仍属 P1。project 按项目过滤（透传 buildKnowledgeGraph）。 */
  async knowledgeGraph(input: unknown = {}): Promise<ReturnType<typeof buildKnowledgeGraph>> {
    if (!this.knowledgeStore) {
      throw new WeaveError('configuration_error', 'knowledgeStore 未注入（knowledge/graph 需要 KnowledgeStore）')
    }
    const p = asPayload(input)
    const statusValue = optionalString(p, 'status')
    const layerValue = optionalString(p, 'layer')
    const status = statusValue !== undefined ? enumOrThrow(statusValue, KNOWLEDGE_STATUSES, '知识状态') as KnowledgeStatus : undefined
    const layer = layerValue !== undefined ? enumOrThrow(layerValue, KNOWLEDGE_LAYERS, '知识层级') as KnowledgeLayer : undefined
    const limitRaw = optionalPositiveInt(p, 'limit')
    const project = optionalString(p, 'project')
    return await buildKnowledgeGraph(this.knowledgeStore, {
      ...(status ? { status } : {}),
      ...(layer ? { layer } : {}),
      ...(limitRaw ? { limit: limitRaw } : {}),
      ...(project ? { project } : {}),
    })
  }

  /** knowledge/import/upload：浏览器 base64 上传到服务端临时目录。 */
  async importUpload(input: unknown): Promise<unknown> {
    if (!this.importPipeline) throw new WeaveError('configuration_error', 'importPipeline 未注入（knowledge/import 需要 ImportPipeline）')
    const p = asPayload(input)
    const filename = requireString(p, 'filename')
    const dataB64 = requireString(p, 'data')
    const meta = p['meta'] as ImportMeta | undefined
    if (!meta) throw new WeaveError('invalid_argument', 'meta 不能为空')
    const dir = join(homedir(), '.dsh', 'imports')
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
    writeFileSync(filePath, Buffer.from(dataB64, 'base64'))
    return this.importPipeline.upload({ original_filename: filename, local_path: filePath }, meta)
  }

  /** knowledge/import/convert：AnyDoc 转换。 */
  async importConvert(input: unknown): Promise<unknown> {
    if (!this.importPipeline) throw new WeaveError('configuration_error', 'importPipeline 未注入')
    return this.importPipeline.convert(requireString(asPayload(input), 'jobId', 'job_id'))
  }

  /** knowledge/import/preview：读转换后的 Markdown。 */
  async importPreview(input: unknown): Promise<unknown> {
    if (!this.importPipeline) throw new WeaveError('configuration_error', 'importPipeline 未注入')
    return this.importPipeline.preview(requireString(asPayload(input), 'jobId', 'job_id'))
  }

  /** knowledge/import/confirm：生成 candidate。 */
  async importConfirm(input: unknown): Promise<unknown> {
    if (!this.importPipeline) throw new WeaveError('configuration_error', 'importPipeline 未注入')
    const p = asPayload(input)
    const jobId = requireString(p, 'jobId', 'job_id')
    const candidate = p['candidate'] as KnowledgeCandidate | undefined
    if (!candidate) throw new WeaveError('invalid_argument', 'candidate 不能为空')
    return this.importPipeline.confirm(jobId, candidate)
  }

  /** knowledge/import/cancel：取消导入任务。 */
  async importCancel(input: unknown): Promise<unknown> {
    if (!this.importPipeline) throw new WeaveError('configuration_error', 'importPipeline 未注入')
    await this.importPipeline.cancel(requireString(asPayload(input), 'jobId', 'job_id'))
    return { cancelled: true }
  }

  /* --------------------------------- 审计域 --------------------------------- */

  /** audit/list：types/from/to/limit/order，转发 AuditLog.query（JSONL 真实审计）。 */
  async auditList(input: unknown): Promise<{ events: Awaited<ReturnType<AuditLog['query']>> }> {
    if (!this.auditLog) {
      throw new WeaveError('configuration_error', 'auditLog 未注入（audit/list 需要 AuditLog）')
    }
    const p = asPayload(input)
    let types: AuditEventType[] | undefined
    const rawTypes = p['types']
    if (rawTypes !== undefined && rawTypes !== null) {
      if (!Array.isArray(rawTypes)) {
        throw new WeaveError('invalid_argument', 'types 必须为数组')
      }
      types = rawTypes.map((t) => {
        if (typeof t !== 'string') {
          throw new WeaveError('invalid_argument', `审计事件类型必须为字符串: ${String(t)}`)
        }
        return enumOrThrow(t, AUDIT_EVENT_TYPES, '审计事件类型')
      })
    }
    const timeOrThrow = (key: string): string | undefined => {
      const value = optionalString(p, key)
      if (value !== undefined && Number.isNaN(Date.parse(value))) {
        throw new WeaveError('invalid_argument', `${key} 必须是可解析的时间（ISO 8601）`, { value })
      }
      return value
    }
    const from = timeOrThrow('from')
    const to = timeOrThrow('to')
    const limit = optionalPositiveInt(p, 'limit') ?? 100
    const order = enumOrThrow(optionalString(p, 'order') ?? 'desc', ['asc', 'desc'] as const, '排序方向')
    const query: AuditQuery = { limit, order, ...(types ? { types } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }
    return { events: await this.auditLog.query(query) }
  }

  /* --------------------------------- 会话域 --------------------------------- */

  /** session/bindings：直读 core.db team_bindings（最近更新优先）。 */
  async sessionBindings(input: unknown = {}): Promise<{ bindings: Array<{ session_id: string; team_id: string; updated_at: string }> }> {
    asPayload(input)
    const bindings = await this.persistence.core.run((db) => {
      db.exec(TEAM_BINDINGS_TABLE_DDL) // 幂等兜底：兼容尚未升到 core v2 的旧库
      return db
        .prepare('SELECT session_id, team_id, updated_at FROM team_bindings ORDER BY updated_at DESC, session_id ASC')
        .all() as Array<{ session_id: string; team_id: string; updated_at: string }>
    })
    return { bindings }
  }

  /** session/revisions：revision_records 最近优先；可按 taskId 过滤（零或一）。 */
  async sessionRevisions(input: unknown): Promise<{ revisions: Awaited<ReturnType<SessionTracker['listRevisions']>> }> {
    if (!this.sessionTracker) {
      throw new WeaveError('configuration_error', 'sessionTracker 未注入（session/revisions 需要 SessionTracker）')
    }
    const p = asPayload(input)
    const taskId = optionalString(p, 'taskId', 'task_id')
    if (taskId !== undefined) {
      const record = await this.sessionTracker.getRevisionRecord(taskId)
      return { revisions: record ? [record] : [] }
    }
    const limit = optionalPositiveInt(p, 'limit') ?? 50
    return { revisions: await this.sessionTracker.listRevisions(limit) }
  }

  /** session/set-binding：校验团队存在后复用 TeamManager.bindTeam（upsert）。 */
  async sessionSetBinding(input: unknown): Promise<{ session_id: string; team_id: string }> {
    if (!this.teamManager) {
      throw new WeaveError('configuration_error', 'teamManager 未注入（session/set-binding 需要 TeamManager）')
    }
    const p = asPayload(input)
    const sessionId = requireString(p, 'sessionId', 'session_id')
    const teamId = requireString(p, 'teamId', 'team_id')
    this.teamManager.loadTeam(teamId) // 不存在 → invalid_team 冒泡
    await this.teamManager.bindTeam(sessionId, teamId)
    return { session_id: sessionId, team_id: teamId }
  }

  /** session/clear-binding：复用 TeamManager.unbindTeam，返回是否确有绑定被清除。 */
  async sessionClearBinding(input: unknown): Promise<{ session_id: string; unbound: boolean }> {
    if (!this.teamManager) {
      throw new WeaveError('configuration_error', 'teamManager 未注入（session/clear-binding 需要 TeamManager）')
    }
    const p = asPayload(input)
    const sessionId = requireString(p, 'sessionId', 'session_id')
    const unbound = await this.teamManager.unbindTeam(sessionId)
    return { session_id: sessionId, unbound }
  }

  /**
   * session/status：会话视图面板数据源——绑定团队 + 成员实时状态。
   * 状态派生：调度器占用表（执行中）> 本会话最近任务持久化状态（completed/failed 等）> idle。
   */
  async sessionStatus(input: unknown): Promise<{
    session_id: string
    team: { team_id: string; name: string } | null
    /** 团队解析来源：binding=显式启用/绑定；default/single=零仪式自动解析。 */
    resolved_via?: 'binding' | 'default' | 'single' | null
    members: Array<{
      role_id: string
      name: string
      executor: string
      status: 'idle' | 'running' | string
      task_id?: string
      subject?: string
      started_at?: string
      last_task_id?: string
      last_status?: TaskStatus
      last_subject?: string
    }>
  }> {
    if (!this.teamManager) {
      throw new WeaveError('configuration_error', 'teamManager 未注入（session/status 需要 TeamManager）')
    }
    const p = asPayload(input)
    const sessionId = requireString(p, 'sessionId', 'session_id')
    // 零仪式：与 planner 同一条优先级链（绑定 > 默认 > 唯一）；未配置任何团队才为 null。
    const resolved = await this.teamManager.resolveSessionTeam(sessionId)
    if (!resolved.team) {
      return { session_id: sessionId, team: null, resolved_via: null, members: [] }
    }
    const team = resolved.team

    // 本会话最近的任务（跨 DAG，按创建时间倒序取一批），每个角色取最近一条做“上次结果”。
    const recent = await this.persistence.tasks.run((db) => {
      return db
        .prepare(
          `SELECT id, dag_id, description, assigned_agent AS assignedAgent, status, created_at AS createdAt
           FROM tasks WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50`,
        )
        .all(sessionId) as unknown as Array<{
        id: string
        dag_id: string
        description: string
        assignedAgent: string | null
        status: TaskStatus
        createdAt: string
      }>
    })
    const lastByRole = new Map<string, (typeof recent)[number]>()
    for (const row of recent) {
      const roleId = row.assignedAgent ?? ''
      if (roleId !== '' && !lastByRole.has(roleId)) lastByRole.set(roleId, row)
    }

    const runtime = this.scheduler?.memberRuntime(sessionId) ?? []
    const runtimeByRole = new Map(runtime.map((item) => [item.role_id, item]))

    const members = team.roles.map((role) => {
      const active = runtimeByRole.get(role.id)
      const last = lastByRole.get(role.id)
      let status: string = 'idle'
      // 假并行修复：排队（已派发未拿到执行器槽）与真正执行分开呈现。
      if (active) status = active.phase === 'queued' ? 'queued' : 'running'
      else if (last) status = statusLabel(last.status)
      return {
        role_id: role.id,
        name: role.name,
        executor: role.executor,
        status,
        ...(active
          ? { task_id: active.task_id, subject: active.subject, started_at: active.started_at, phase: active.phase }
          : {}),
        ...(last && !active
          ? { last_task_id: last.id, last_status: last.status, last_subject: subjectOf(last.description) }
          : {}),
      }
    })

    return {
      session_id: sessionId,
      team: { team_id: team.team_id, name: team.name },
      resolved_via: resolved.via,
      members,
    }
  }

  /* ------------------------------- endpoint 分发 ------------------------------- */

  /** RPC 层单入口分发器；未知端点 invalid_argument（与 rpc.ts 行为一致）。 */
  async dispatch(endpoint: string, payload: unknown): Promise<unknown> {
    switch (endpoint) {
      case 'task/list':
        return this.taskList(payload)
      case 'task/get':
        return this.taskGet(payload)
      case 'task/action':
        return this.taskAction(payload)
      case 'knowledge/list':
        return this.knowledgeList(payload)
      case 'knowledge/approve':
        return this.knowledgeApprove(payload)
      case 'knowledge/reject':
        return this.knowledgeReject(payload)
      case 'knowledge/graph':
        return this.knowledgeGraph(payload ?? {})
      case 'knowledge/import/upload':
        return this.importUpload(payload ?? {})
      case 'knowledge/import/convert':
        return this.importConvert(payload ?? {})
      case 'knowledge/import/preview':
        return this.importPreview(payload ?? {})
      case 'knowledge/import/confirm':
        return this.importConfirm(payload ?? {})
      case 'knowledge/import/cancel':
        return this.importCancel(payload ?? {})
      case 'audit/list':
        return this.auditList(payload)
      case 'session/bindings':
        return this.sessionBindings(payload ?? {})
      case 'session/revisions':
        return this.sessionRevisions(payload)
      case 'session/set-binding':
        return this.sessionSetBinding(payload)
      case 'session/clear-binding':
        return this.sessionClearBinding(payload)
      case 'session/status':
        return this.sessionStatus(payload)
      default:
        throw new WeaveError('invalid_argument', `未知 RPC endpoint: ${endpoint}`)
    }
  }
}

/**
 * 生产接线工厂（t4）：从宿主已组装的 CliMcpDeps 派生 WeaveQueryService。
 * mcp / 审计日志（目录与 KnowledgeReview 一致）/ 修订跟踪在此按需构造，
 * 由 index.ts 注入 registerWeaveRpc 的 deps.queryService；extras.scheduler 为
 * 队长调度器（session/status 成员实时状态数据源）。
 */
export function createWeaveQueryServiceFromCliDeps(
  deps: CliMcpDeps,
  extras: { scheduler?: WeaveScheduler } = {},
): WeaveQueryService {
  return new WeaveQueryService({
    persistence: deps.persistence,
    mcp: new WeaveMcp(deps),
    auditLog: new AuditLog({ dir: DEFAULT_AUDIT_DIR }),
    sessionTracker: new SessionTracker(deps.persistence.feedback),
    teamManager: deps.teamManager,
    ...(extras.scheduler ? { scheduler: extras.scheduler } : {}),
    knowledgeStore: deps.knowledgeStore,
    importPipeline: deps.importPipeline,
  })
}
