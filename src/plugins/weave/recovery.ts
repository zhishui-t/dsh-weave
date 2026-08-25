import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WeaveDatabase } from './persistence/weave-database.js'
import { AuditLog } from './audit/audit-log.js'

/**
 * P0-RECOVERY-018 崩溃恢复一致性 — 对应 SDD 6.6 / AC-RECOVERY-001。
 *
 * 启动时执行三类修复（幂等，可重复运行）：
 * 1. 任务：`RUNNING / REVISION_RUNNING` 中间态 → `FAILED`，`error_type='crash_recovery'`；
 * 2. 导入：`import_jobs` 全部非终态（uploaded/converting/converted/previewing/reviewing）→ `failed`，
 *    写入可读 error_message（失败不写 knowledge/_agent 的语义由 ImportPipeline 保证，恢复不新增知识）；
 * 3. 知识元数据：`knowledge_meta.status ∈ {candidate, active}` 但对应文件丢失 → `deprecated`
 *    （文件不可检索，与生命周期 candidate/active → deprecated 一致）。
 *
 * 所有 DB 修复动作在单写者队列内以事务（BEGIN IMMEDIATE / COMMIT / ROLLBACK）执行；
 * 每项修复写审计事件（recovery.task_repaired / knowledge.status_changed / recovery.import_repaired），
 * 审计失败不阻断修复（记录在报告中）。
 */

export interface RecoveryReport {
  scanned: number
  repaired: number
  skipped: number
  auditFailed: number
  actions: string[]
}

export interface RecoveryOptions {
  /** tasks.db（P0-DB-004） */
  tasksDb: WeaveDatabase
  /** imports.db（P0-DB-004） */
  importsDb: WeaveDatabase
  /** knowledge_meta.db（P0-DB-004） */
  knowledgeMetaDb: WeaveDatabase
  /** knowledge 根目录（~/.dsh/knowledge），用于文件存在性对账 */
  knowledgeRoot: string
  /** 审计日志；默认 new AuditLog()（~/.dsh/audit 目录模型） */
  audit?: AuditLog
  now?: () => Date
}

/** 需要修复的任务中间态：RUNNING / REVISION_RUNNING（SDD 6.6 扫描范围）。 */
export const RUNNING_TASK_STATUSES = ['RUNNING', 'REVISION_RUNNING'] as const
/** 需要修复的导入非终态（TDD 3.1.4 状态机；终态 = cancelled/failed/confirmed/active）。 */
export const NON_TERMINAL_IMPORT_STATUSES = ['uploaded', 'converting', 'converted', 'previewing', 'reviewing'] as const

export class RecoveryService {
  readonly #options: RecoveryOptions
  readonly #audit: AuditLog
  readonly #now: () => Date

  constructor(options: RecoveryOptions) {
    this.#options = options
    this.#audit = options.audit ?? new AuditLog()
    this.#now = options.now ?? (() => new Date())
  }

  /** 全量恢复：任务 → 导入 → 知识元数据。 */
  async recoverAll(): Promise<RecoveryReport> {
    const reports = [
      await this.repairTasks(),
      await this.repairImports(),
      await this.repairKnowledgeMeta(),
    ]
    return {
      scanned: reports.reduce((sum, r) => sum + r.scanned, 0),
      repaired: reports.reduce((sum, r) => sum + r.repaired, 0),
      skipped: reports.reduce((sum, r) => sum + r.skipped, 0),
      auditFailed: reports.reduce((sum, r) => sum + r.auditFailed, 0),
      actions: reports.flatMap((r) => r.actions),
    }
  }

  /** 修复 RUNNING / REVISION_RUNNING 中间态任务（SDD 6.6）。幂等。 */
  async repairTasks(): Promise<RecoveryReport> {
    const report = this.#emptyReport()
    const placeholders = RUNNING_TASK_STATUSES.map(() => '?').join(', ')
    const rows = await this.#options.tasksDb.run((raw) => {
      return raw
        .prepare(`SELECT id, status FROM tasks WHERE status IN (${placeholders})`)
        .all(...RUNNING_TASK_STATUSES)
    })
    report.scanned = rows.length

    for (const row of rows) {
      const taskId = String(row.id)
      const from = String(row.status)
      const now = this.#now().toISOString()
      await this.#transact(this.#options.tasksDb, () => {
        const result = this.#options.tasksDb.raw
          .prepare(
            `UPDATE tasks
             SET status = 'FAILED', error_type = COALESCE(error_type, 'crash_recovery'), updated_at = ?
             WHERE id = ? AND status = ?`,
          )
          .run(now, taskId, from)
        if (result.changes === 0) {
          throw new Error(`恢复竞态：任务状态已变化: ${taskId}`)
        }
      })
      report.repaired++
      report.actions.push(`task ${taskId}: ${from} → FAILED (crash_recovery)`)
      await this.#auditSafe(report, {
        type: 'recovery.task_repaired',
        task_id: taskId,
        from,
        to: 'FAILED',
        reason: '崩溃恢复：进程重启时任务处于运行中，置为失败终态',
      })
    }
    return report
  }

  /** 修复 import_jobs 非终态（SDD 6.6）。幂等。 */
  async repairImports(): Promise<RecoveryReport> {
    const report = this.#emptyReport()
    const placeholders = NON_TERMINAL_IMPORT_STATUSES.map(() => '?').join(', ')
    const rows = await this.#options.importsDb.run((raw) => {
      return raw
        .prepare(`SELECT id, status FROM import_jobs WHERE status IN (${placeholders})`)
        .all(...NON_TERMINAL_IMPORT_STATUSES)
    })
    report.scanned = rows.length

    for (const row of rows) {
      const jobId = String(row.id)
      const from = String(row.status)
      const now = this.#now().toISOString()
      await this.#transact(this.#options.importsDb, () => {
        const result = this.#options.importsDb.raw
          .prepare(
            `UPDATE import_jobs
             SET status = 'failed', error_message = COALESCE(error_message, '崩溃恢复：导入未完成，请重新上传'), updated_at = ?
             WHERE id = ? AND status = ?`,
          )
          .run(now, jobId, from)
        if (result.changes === 0) {
          throw new Error(`恢复竞态：导入任务状态已变化: ${jobId}`)
        }
      })
      report.repaired++
      report.actions.push(`import ${jobId}: ${from} → failed`)
      await this.#auditSafe(report, {
        type: 'recovery.import_repaired',
        job_id: jobId,
        from,
        to: 'failed',
        reason: '崩溃恢复：进程重启时导入任务未完成',
      })
    }
    return report
  }

  /** 知识元数据对账：candidate/active 但文件丢失 → deprecated（一致性）。幂等。 */
  async repairKnowledgeMeta(): Promise<RecoveryReport> {
    const report = this.#emptyReport()
    const rows = await this.#options.knowledgeMetaDb.run((raw) => {
      return raw
        .prepare(
          `SELECT id, path, status FROM knowledge_meta WHERE status IN ('candidate', 'active') ORDER BY id`,
        )
        .all()
    })
    report.scanned = rows.length

    for (const row of rows) {
      const id = String(row.id)
      const from = String(row.status)
      const filePath = join(this.#options.knowledgeRoot, String(row.path))
      if (existsSync(filePath)) {
        report.skipped++
        continue
      }
      const now = this.#now().toISOString()
      await this.#transact(this.#options.knowledgeMetaDb, () => {
        const result = this.#options.knowledgeMetaDb.raw
          .prepare(`UPDATE knowledge_meta SET status = 'deprecated', updated = ? WHERE id = ? AND status = ?`)
          .run(now, id, from)
        if (result.changes === 0) {
          throw new Error(`恢复竞态：知识元数据状态已变化: ${id}`)
        }
      })
      report.repaired++
      report.actions.push(`knowledge ${id}: ${from} → deprecated (file missing: ${String(row.path)})`)
      await this.#auditSafe(report, {
        type: 'knowledge.status_changed',
        knowledge_id: id,
        from,
        to: 'deprecated',
      })
    }
    return report
  }

  // ===== 内部 =====

  #emptyReport(): RecoveryReport {
    return { scanned: 0, repaired: 0, skipped: 0, auditFailed: 0, actions: [] }
  }

  /**
   * 事务包装：在单写者队列内执行 BEGIN IMMEDIATE → write → COMMIT；异常 ROLLBACK 并重新抛出。
   * write 内的 SQL 均通过 WeaveDatabase.raw（同连接，事务覆盖）。
   */
  async #transact(db: WeaveDatabase, write: () => void): Promise<void> {
    await db.run((raw) => {
      raw.exec('BEGIN IMMEDIATE')
      try {
        write()
        raw.exec('COMMIT')
      } catch (error) {
        raw.exec('ROLLBACK')
        throw error
      }
    })
  }

  /** 审计失败不阻断修复，计入报告。 */
  async #auditSafe(
    report: RecoveryReport,
    event: Parameters<AuditLog['record']>[0],
  ): Promise<void> {
    try {
      await this.#audit.record(event)
    } catch {
      report.auditFailed++
    }
  }
}
