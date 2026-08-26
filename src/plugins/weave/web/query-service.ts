import { AUDIT_EVENT_TYPES, DEFAULT_AUDIT_DIR, AuditLog, type AuditEventType, type AuditQuery } from '../audit/audit-log.js'
import { WeaveMcp, type CliMcpDeps, type SubmitTaskInput } from '../cli-mcp.js'
import { DagRepository } from '../dag/repository.js'
import type { WeavePersistence } from '../persistence/persistence.js'
import { TEAM_BINDINGS_TABLE_DDL } from '../persistence/schemas.js'
import { SessionTracker } from '../session-tracker.js'
import { TASK_STATUSES, type TaskRecord } from '../state/types.js'
import { WeaveError } from '../state/weave-error.js'
import { KnowledgeStore, type KnowledgeLayer, type KnowledgeStatus } from '../knowledge-model.js'
import type { TeamManager } from '../team-manager.js'
import { buildKnowledgeGraph } from './knowledge-graph.js'

/**
 * Web 真实数据查询/操作服务（t2）——供 RPC 层（rpc.ts 由 weave-dev-api 接线）调用的
 * 任务、知识库、审计、会话四域能力。全部读写真实持久化层：
 * - 任务列表/DAG 详情：tasks.db（tasks/dags/edges 表）；
 * - 任务创建与动作：复用 WeaveMcp（submitTask / revise / accept / retry / skip / cancel / reopen）；
 * - 知识：复用 WeaveMcp.knowledgeReview / approve / reject（candidate 队列 + 元数据状态查询）；
 * - 审计：AuditLog.query（JSONL 追加日志，无 fake 数据路径）；
 * - 会话绑定：core.db team_bindings 直读；set/clear 复用 TeamManager 现有方法；
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

export interface QueryServiceDeps {
  /** 五库持久化句柄（tasks/core/feedback/knowledgeMeta/imports）。 */
  persistence: WeavePersistence
  /** MCP 层：task/create、task/action、knowledge/* 复用；缺省时相应端点 configuration_error。 */
  mcp?: WeaveMcp
  /** 审计日志：audit/list 用。 */
  auditLog?: AuditLog
  /** 修订上下文：session/revisions 用。 */
  sessionTracker?: SessionTracker
  /** 团队管理：session/set-binding、clear-binding 复用现有绑定方法。 */
  teamManager?: TeamManager
  /** 知识仓库：knowledge/graph 只读真实知识文件与 [[双链]]。 */
  knowledgeStore?: KnowledgeStore
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
  private readonly knowledgeStore?: KnowledgeStore
  private readonly dagRepository: DagRepository

  constructor(deps: QueryServiceDeps) {
    this.persistence = deps.persistence
    this.mcp = deps.mcp
    this.auditLog = deps.auditLog
    this.sessionTracker = deps.sessionTracker
    this.teamManager = deps.teamManager
    this.knowledgeStore = deps.knowledgeStore
    this.dagRepository = new DagRepository(deps.persistence)
  }

  /* --------------------------------- 任务域 --------------------------------- */

  /**
   * task/list：分页 + 过滤（teamId/projectId/status/search），updated_at 降序。
   * 分页两种形态二选一：page(+pageSize 默认 20) 或 limit(默认 50)+offset(默认 0)，混用报错。
   * search 对 description/id 做 LIKE 包含匹配（%/_/\ 转义）。
   */
  async taskList(input: unknown): Promise<{ total: number; tasks: TaskRecord[] }> {
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

  /** task/create：完全复用 WeaveMcp.submitTask（团队校验/序号/DAG 落库均在其内）。 */
  async taskCreate(input: unknown): Promise<{ dag_id: string; tasks: TaskRecord[]; status: 'submitted' }> {
    if (!this.mcp) {
      throw new WeaveError('configuration_error', 'mcp 未注入（task/create 需要 WeaveMcp）')
    }
    return this.mcp.submitTask(asPayload(input) as unknown as SubmitTaskInput)
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

  /** knowledge/graph：读取真实知识文件；轻量双链图，完整 Graphify 仍属 P1。 */
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
    return await buildKnowledgeGraph(this.knowledgeStore, {
      ...(status ? { status } : {}),
      ...(layer ? { layer } : {}),
      ...(limitRaw ? { limit: limitRaw } : {}),
    })
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

  /* ------------------------------- endpoint 分发 ------------------------------- */

  /** RPC 层单入口分发器；未知端点 invalid_argument（与 rpc.ts 行为一致）。 */
  async dispatch(endpoint: string, payload: unknown): Promise<unknown> {
    switch (endpoint) {
      case 'task/list':
        return this.taskList(payload)
      case 'task/get':
        return this.taskGet(payload)
      case 'task/create':
        return this.taskCreate(payload)
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
      default:
        throw new WeaveError('invalid_argument', `未知 RPC endpoint: ${endpoint}`)
    }
  }
}

/**
 * 生产接线工厂（t4）：从宿主已组装的 CliMcpDeps 派生 WeaveQueryService。
 * mcp / 审计日志（目录与 KnowledgeReview 一致）/ 修订跟踪在此按需构造，
 * 由 index.ts 注入 registerWeaveRpc 的 deps.queryService。
 */
export function createWeaveQueryServiceFromCliDeps(deps: CliMcpDeps): WeaveQueryService {
  return new WeaveQueryService({
    persistence: deps.persistence,
    mcp: new WeaveMcp(deps),
    auditLog: new AuditLog({ dir: DEFAULT_AUDIT_DIR }),
    sessionTracker: new SessionTracker(deps.persistence.feedback),
    teamManager: deps.teamManager,
    knowledgeStore: deps.knowledgeStore,
  })
}
