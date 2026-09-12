import type { WeaveDatabase } from '../persistence/weave-database.js'
import { AuditLog } from '../audit/audit-log.js'
import type { TaskStatusNotifier } from './task-status-notifier.js'
import type { TaskStatus } from '../state/types.js'
import type { TaskLivenessProbe, TaskLivenessVerdict } from './task-liveness.js'

/**
 * P0-RECOVERY-018 崩溃恢复一致性 — 对应 SDD 6.6 / AC-RECOVERY-001。
 *
 * 启动时执行三类修复（幂等，可重复运行）：
 * 1. 任务：`RUNNING / REVISION_RUNNING` 中间态默认 → `FAILED`，`error_type='crash_recovery'`；
 *    注入 liveness 探针后升级为恢复对账（对照官方 agent-team roster.reconcileProvisioning）：
 *    子代理活着 → 保持 RUNNING（followup 边界在下次派发时按事件边界自动重挂）；
 *    会话有持久产物（executor_children / ACP 会话索引命中）→ 保持 RUNNING 可续；
 *    两处皆无 → FAILED(crash_recovery)。探针异常按保守旧行为 FAILED 并审计原因。
 * （导入与知识元数据修复已随能力移交 Prism 控制面而移除；prism 自管其数据一致性。）
 *
 * 所有 DB 修复动作在单写者队列内以事务（BEGIN IMMEDIATE / COMMIT / ROLLBACK）执行；
 * 每项修复写审计事件（recovery.task_repaired / recovery.task_reconciled），审计失败不阻断修复（记录在报告中）。
 */

export interface RecoveryReport {
  scanned: number
  repaired: number
  /** 对账后保持原状（alive/artifacts，不判死）的任务数。 */
  reconciled: number
  skipped: number
  auditFailed: number
  actions: string[]
}

export interface RecoveryOptions {
  /** tasks.db（P0-DB-004） */
  tasksDb: WeaveDatabase
  /** 审计日志；默认 new AuditLog()（~/.dsh/audit 目录模型） */
  audit?: AuditLog
  /** 任务状态变更通知单出口（doc/05 §6.4 P1-D 接线点 6）：崩溃修复发电，actor=recovery。 */
  statusNotifier?: TaskStatusNotifier
  /** 可选恢复对账探针：缺省时保持旧行为（RUNNING 一律 FAILED）。 */
  liveness?: TaskLivenessProbe
  now?: () => Date
}

/** 需要修复的任务中间态：RUNNING / REVISION_RUNNING（SDD 6.6 扫描范围）。 */
export const RUNNING_TASK_STATUSES = ['RUNNING', 'REVISION_RUNNING'] as const

export class RecoveryService {
  readonly #options: RecoveryOptions
  readonly #audit: AuditLog
  readonly #now: () => Date

  constructor(options: RecoveryOptions) {
    this.#options = options
    this.#audit = options.audit ?? new AuditLog()
    this.#now = options.now ?? (() => new Date())
  }

  /** 全量恢复：任务（导入/知识修复已移交 Prism）。 */
  async recoverAll(): Promise<RecoveryReport> {
    const reports = [
      await this.repairTasks(),
    ]
    return {
      scanned: reports.reduce((sum, r) => sum + r.scanned, 0),
      repaired: reports.reduce((sum, r) => sum + r.repaired, 0),
      reconciled: reports.reduce((sum, r) => sum + r.reconciled, 0),
      skipped: reports.reduce((sum, r) => sum + r.skipped, 0),
      auditFailed: reports.reduce((sum, r) => sum + r.auditFailed, 0),
      actions: reports.flatMap((r) => r.actions),
    }
  }

  /**
   * 修复 RUNNING / REVISION_RUNNING 中间态任务（SDD 6.6）。幂等。
   * 注入 liveness 探针时先对账：alive/artifacts 保持 RUNNING（recovery.task_reconciled），
   * dead（或探针异常，保守回落）→ FAILED(crash_recovery)（recovery.task_repaired）。
   */
  async repairTasks(): Promise<RecoveryReport> {
    const report = this.#emptyReport()
    const placeholders = RUNNING_TASK_STATUSES.map(() => '?').join(', ')
    const rows = await this.#options.tasksDb.run((raw) => {
      return raw
        .prepare(
          `SELECT id, status, session_id, dag_id, description, team_id, project_id, version, assigned_agent, executor
           FROM tasks WHERE status IN (${placeholders})`,
        )
        .all(...RUNNING_TASK_STATUSES)
    })
    report.scanned = rows.length

    for (const row of rows) {
      const taskId = String(row.id)
      const from = String(row.status)
      const now = this.#now().toISOString()

      // 恢复对账（可选探针）：三分支裁定 alive/artifacts/dead。
      const verdict = await this.#probeRow(row, taskId)

      if (verdict.verdict !== 'dead') {
        report.reconciled++
        report.actions.push(`task ${taskId}: ${from} kept ${from} (${verdict.verdict}; ${verdict.detail})`)
        await this.#auditSafe(report, {
          type: 'recovery.task_reconciled',
          task_id: taskId,
          verdict: verdict.verdict,
          detail: `重启对账保持 ${from}：${verdict.detail}`,
        })
        continue
      }

      await this.#transact(this.#options.tasksDb, () => {
        const result = this.#options.tasksDb.raw
          .prepare(
            `UPDATE tasks
             SET status = 'FAILED', error_type = COALESCE(error_type, 'crash_recovery'),
                 attempt_token = NULL, revision = revision + 1, updated_at = ?
             WHERE id = ? AND status = ?`,
          )
          .run(now, taskId, from)
        if (result.changes === 0) {
          throw new Error(`恢复竞态：任务状态已变化: ${taskId}`)
        }
      })
      report.repaired++
      report.actions.push(`task ${taskId}: ${from} → FAILED (crash_recovery; ${verdict.detail})`)
      // 接线点 6（doc/05 §6.4）：崩溃修复发电（与既有 audit.record 同位置），actor=recovery。
      const description = String((row as { description?: unknown }).description ?? '')
      this.#options.statusNotifier?.notify({
        taskId,
        dagId: String((row as { dag_id?: unknown }).dag_id ?? ''),
        sessionId: String((row as { session_id?: unknown }).session_id ?? ''),
        subject: description.split('\n')[0]?.trim() || taskId,
        from: from as TaskStatus,
        to: 'FAILED',
        actor: 'recovery',
        source: 'crash_recovery',
      })
      await this.#auditSafe(report, {
        type: 'recovery.task_repaired',
        task_id: taskId,
        from,
        to: 'FAILED',
        reason: `崩溃恢复：进程重启时任务处于运行中，置为失败终态（${verdict.detail}）`,
      })
    }
    return report
  }

  /**
   * 对账裁定：探针缺省 → dead（旧行为）；探针异常 → dead（保守回落，detail 带异常原因）。
   * detail 随审计落 recovery.task_reconciled / recovery.task_repaired，对账结果可追溯。
   */
  async #probeRow(row: Record<string, unknown>, taskId: string): Promise<TaskLivenessVerdict> {
    const probe = this.#options.liveness
    if (!probe) {
      return { verdict: 'dead', detail: 'no liveness probe configured (legacy behavior)' }
    }
    try {
      return await probe.probeTask({
        taskId,
        executor: row.executor === undefined || row.executor === null ? null : String(row.executor),
        sessionId: String(row.session_id ?? ''),
        sessionKey: `${String(row.team_id ?? '')}:${String(row.assigned_agent ?? '')}:${String(row.project_id ?? '')}:${String(row.version ?? '')}`,
      })
    } catch (error) {
      return { verdict: 'dead', detail: `liveness probe failed (conservative FAILED): ${String(error)}` }
    }
  }

  // ===== 内部 =====

  #emptyReport(): RecoveryReport {
    return { scanned: 0, repaired: 0, reconciled: 0, skipped: 0, auditFailed: 0, actions: [] }
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
