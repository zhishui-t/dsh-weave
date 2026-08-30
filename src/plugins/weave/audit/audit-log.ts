import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { SingleWriterQueue } from '../persistence/single-writer-queue.js'
import { TASK_STATUSES } from '../state/types.js'
import { WeaveError } from '../state/weave-error.js'

/** 审计事件类型（架构 9.3 / SDD 7.5 + AC-IMPORT-003 导入确认） */
export const AUDIT_EVENT_TYPES = [
  'task.status_changed',
  'task.feedback_received',
  'knowledge.status_changed',
  'knowledge.superseded',
  'knowledge.deposited',
  'import.confirmed',
  'ban.created',
  'ban.resolved',
  'team.switched',
  'recovery.task_repaired',
  'recovery.import_repaired',
] as const

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

export interface AuditEventBase {
  /** 事件 ID（不留则自动生成 UUID） */
  id?: string
  type: AuditEventType
  /** ISO 8601 发生时间（不留则取当前时间） */
  occurred_at?: string
  session_id?: string | null
}

export type AuditEvent =
  | (AuditEventBase & { type: 'task.status_changed'; task_id: string; from: string; to: string; by: string })
  | (AuditEventBase & { type: 'task.feedback_received'; task_id: string; revision_count: number })
  | (AuditEventBase & { type: 'knowledge.status_changed'; knowledge_id: string; from: string; to: string })
  | (AuditEventBase & { type: 'knowledge.superseded'; new_id: string; old_id: string; reason: string })
  | (AuditEventBase & { type: 'knowledge.deposited'; knowledge_id: string; task_id: string; executor: string; layer: string })
  | (AuditEventBase & { type: 'import.confirmed'; job_id: string; candidate_id: string })
  | (AuditEventBase & { type: 'ban.created'; ban_id: string; scope: string; entity_key: string })
  | (AuditEventBase & { type: 'ban.resolved'; ban_id: string; scope: string; entity_key: string })
  | (AuditEventBase & { type: 'team.switched'; session_id: string; from_team: string; to_team: string })
  | (AuditEventBase & { type: 'recovery.task_repaired'; task_id: string; from: string; to: string; reason: string })
  | (AuditEventBase & { type: 'recovery.import_repaired'; job_id: string; from: string; to: string; reason: string })

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type AuditEventInput = DistributiveOmit<AuditEvent, 'id' | 'occurred_at'> & { occurred_at?: string }

/** 各事件类型的必填字段（架构 9.3 事件字段表） */
export const AUDIT_EVENT_REQUIRED_FIELDS: Record<AuditEventType, readonly string[]> = {
  'task.status_changed': ['task_id', 'from', 'to', 'by'],
  'task.feedback_received': ['task_id', 'revision_count'],
  'knowledge.status_changed': ['knowledge_id', 'from', 'to'],
  'knowledge.superseded': ['new_id', 'old_id', 'reason'],
  'knowledge.deposited': ['knowledge_id', 'task_id', 'executor', 'layer'],
  'import.confirmed': ['job_id', 'candidate_id'],
  'ban.created': ['ban_id', 'scope', 'entity_key'],
  'ban.resolved': ['ban_id', 'scope', 'entity_key'],
  'team.switched': ['session_id', 'from_team', 'to_team'],
  'recovery.task_repaired': ['task_id', 'from', 'to', 'reason'],
  'recovery.import_repaired': ['job_id', 'from', 'to', 'reason'],
}

export interface AuditLogOptions {
  /** audit 目录，默认 ~/.dsh/audit（TDD 2.7） */
  dir?: string
  /** 单写者队列；与持久化层共享时传入同一队列 */
  queue?: SingleWriterQueue
  /** 可注入时钟（测试用） */
  now?: () => Date
  idFactory?: () => string
}

export interface AuditQuery {
  types?: AuditEventType[]
  taskId?: string
  knowledgeId?: string
  banId?: string
  jobId?: string
  sessionId?: string
  /** ISO 8601，含边界 */
  from?: string
  to?: string
  limit?: number
  order?: 'asc' | 'desc'
}

export const DEFAULT_AUDIT_DIR = join(homedir(), '.dsh', 'audit')

/**
 * AuditLog — 追加式 JSONL 审计日志（~/.dsh/audit/audit-YYYY-MM-DD.jsonl）。
 * record() 做事件类型/必填字段校验 + task.status_changed 走状态机合法性校验
 * （AC-TASK-002：审计不写非法转移），写入经 SingleWriterQueue 串行化；
 * query() 提供查询入口：按类型/实体/时间过滤 + limit/order。
 */
export class AuditLog {
  readonly dir: string
  readonly queue: SingleWriterQueue
  readonly #now: () => Date
  readonly #idFactory: () => string

  constructor(options: AuditLogOptions = {}) {
    this.dir = options.dir ?? DEFAULT_AUDIT_DIR
    this.queue = options.queue ?? new SingleWriterQueue()
    this.#now = options.now ?? (() => new Date())
    this.#idFactory = options.idFactory ?? randomUUID
  }

  #fileFor(date: Date): string {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return join(this.dir, `audit-${y}-${m}-${d}.jsonl`)
  }

  /** 写入一条审计事件；返回完整事件（含生成字段）。校验失败抛 WeaveError 且不落盘。 */
  async record(event: AuditEventInput): Promise<AuditEvent> {
    const full: AuditEvent = {
      ...event,
      id: (event as Partial<AuditEvent>).id ?? this.#idFactory(),
      occurred_at: event.occurred_at ?? this.#now().toISOString(),
    } as unknown as AuditEvent
    this.#validate(full)
    const line = `${JSON.stringify(full)}\n`
    await this.queue.run(async () => {
      await mkdir(this.dir, { recursive: true })
      await appendFile(this.#fileFor(this.#now()), line, { encoding: 'utf-8' })
    })
    return full
  }

  #validate(event: AuditEvent): void {
    const asRecord = event as unknown as Record<string, unknown>
    if (!AUDIT_EVENT_TYPES.includes(event.type)) {
      throw new WeaveError('invalid_audit_event', `未知审计事件类型: ${String(event.type)}`, {
        type: event.type,
      })
    }
    const missing = AUDIT_EVENT_REQUIRED_FIELDS[event.type].filter((f) => asRecord[f] == null)
    if (missing.length > 0) {
      throw new WeaveError('invalid_audit_event', `审计事件缺少必填字段: ${missing.join(', ')}`, {
        type: event.type,
        missing,
      })
    }
    if (event.type === 'task.feedback_received' && typeof asRecord.revision_count !== 'number') {
      throw new WeaveError('invalid_audit_event', 'revision_count 必须为数字', { type: event.type })
    }
    if (event.type === 'task.status_changed') {
      const { from, to } = event as { from: string; to: string }
      if (!TASK_STATUSES.includes(from as never) || !TASK_STATUSES.includes(to as never)) {
        throw new WeaveError('invalid_audit_event', `非法状态值: ${from} → ${to}`, { from, to })
      }
    }
  }

  /** 查询入口：按类型/实体/时间过滤，order 默认 desc，limit 默认全部。 */
  async query(filter: AuditQuery = {}): Promise<AuditEvent[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[]))
      .filter((f) => /^audit-.*\.jsonl$/.test(f))
      .sort()
    const events: AuditEvent[] = []
    for (const file of files) {
      const content = await readFile(join(this.dir, file), { encoding: 'utf-8' })
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          events.push(JSON.parse(trimmed) as AuditEvent)
        } catch {
          // 跳过损坏行（容忍部分损坏，不阻断审计查询）
        }
      }
    }
    const matched = events.filter((e) => this.#matches(e, filter))
    matched.sort((a, b) => {
      const cmp = String(a.occurred_at).localeCompare(String(b.occurred_at))
      return (filter.order ?? 'desc') === 'asc' ? cmp : -cmp
    })
    return filter.limit != null ? matched.slice(0, filter.limit) : matched
  }

  #matches(event: AuditEvent, filter: AuditQuery): boolean {
    const e = event as unknown as Record<string, unknown>
    if (filter.types && !filter.types.includes(event.type)) return false
    if (filter.taskId && e.task_id !== filter.taskId) return false
    if (filter.knowledgeId && e.knowledge_id !== filter.knowledgeId) return false
    if (filter.banId && e.ban_id !== filter.banId) return false
    if (filter.jobId && e.job_id !== filter.jobId) return false
    if (filter.sessionId && e.session_id !== filter.sessionId) return false
    if (filter.from && String(e.occurred_at) < filter.from) return false
    if (filter.to && String(e.occurred_at) > filter.to) return false
    return true
  }
}
