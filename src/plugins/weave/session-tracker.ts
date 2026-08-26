import type { WeaveDatabase } from './persistence/weave-database.js'

/**
 * TDD 1.5.5 修订上下文记录。
 *
 * 字段与 TDD 1.5.5 `RevisionRecord` 一一对应；`user_feedback` 在库中按
 * JSON 数组文本（TEXT DEFAULT '[]'）存储，读取时反序列化为 string[]。
 */
export interface RevisionRecord {
  task_id: string
  revision_count: number
  previous_result: string | null
  user_feedback: string[]
  updated_at: string
}

/** 修订上下文表 DDL（feedback.db；表由 SessionTracker 自建，TDD 未单独登记 DDL）。 */
export const REVISION_RECORDS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS revision_records (
    task_id TEXT PRIMARY KEY,
    revision_count INTEGER NOT NULL DEFAULT 0,
    previous_result TEXT,
    user_feedback TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
)`

interface RevisionRow {
  task_id: string
  revision_count: number
  previous_result: string | null
  user_feedback: string
  updated_at: string
}

/**
 * SessionTracker — 修订上下文跟踪（TDD 1.5.5 / 架构 5.4）。
 *
 * 职责：记录/读取/清理一次委托的修订上下文（修订次数、上一版输出摘要、
 * 用户反馈历史），供 DelegationService 在修订执行时注入 prompt。
 *
 * 持久化：feedback.db 的 `revision_records` 表，主键 task_id，与任务一一
 * 隔离（无跨任务状态残留）；所有写操作经 WeaveDatabase.run() 走共享
 * SingleWriterQueue 串行化。
 */
export class SessionTracker {
  readonly #db: WeaveDatabase
  #ready = false

  constructor(db: WeaveDatabase) {
    this.#db = db
  }

  /** 确保表存在（幂等；首次调用时执行）。 */
  async #ensureTable(): Promise<void> {
    if (this.#ready) {
      return
    }
    await this.#db.run((raw) => {
      raw.exec(REVISION_RECORDS_TABLE_DDL)
    })
    this.#ready = true
  }

  /**
   * 记录一次修订：
   * - 新任务：创建记录，revision_count=1，user_feedback=[feedback]；
   * - 已有记录：追加 feedback 到反馈历史，`previous_result` 替换为本次修订
   *   的上一版输出，revision_count + 1；
   * - `updated_at` 更新为当前 ISO 8601 时间。
   */
  async recordRevision(
    taskId: string,
    feedback: string,
    previousResult: string | null,
  ): Promise<void> {
    await this.#ensureTable()
    await this.#db.run((raw) => {
      const now = new Date().toISOString()
      const row = raw
        .prepare('SELECT revision_count, user_feedback FROM revision_records WHERE task_id = ?')
        .get(taskId) as { revision_count: number; user_feedback: string } | undefined

      if (row) {
        const history = JSON.parse(row.user_feedback) as string[]
        history.push(feedback)
        raw
          .prepare(
            `UPDATE revision_records
             SET revision_count = revision_count + 1,
                 previous_result = ?,
                 user_feedback = ?,
                 updated_at = ?
             WHERE task_id = ?`,
          )
          .run(previousResult, JSON.stringify(history), now, taskId)
      } else {
        raw
          .prepare(
            `INSERT INTO revision_records (task_id, revision_count, previous_result, user_feedback, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(taskId, 1, previousResult, JSON.stringify([feedback]), now)
      }
    })
  }

  /** 读取该任务的 RevisionRecord；不存在返回 null。 */
  async getRevisionRecord(taskId: string): Promise<RevisionRecord | null> {
    await this.#ensureTable()
    const row = await this.#db.run((raw) => {
      return raw
        .prepare(
          'SELECT task_id, revision_count, previous_result, user_feedback, updated_at FROM revision_records WHERE task_id = ?',
        )
        .get(taskId) as RevisionRow | undefined
    })
    if (!row) {
      return null
    }
    return {
      task_id: row.task_id,
      revision_count: row.revision_count,
      previous_result: row.previous_result,
      user_feedback: JSON.parse(row.user_feedback) as string[],
      updated_at: row.updated_at,
    }
  }

  /**
   * 生成修订上下文注入文本（架构 5.3 / 5.4 的 prompt 片段）；无记录返回 null。
   *
   * 格式：
   *   ## 之前的版本与用户反馈
   *   这是第 {n} 次修订。
   *   ### 上一版输出
   *   {previous_result 摘要}
   *   ### 用户反馈历史
   *   1. {feedback_1}
   *   2. {feedback_2}
   */
  async getRevisionContext(taskId: string): Promise<string | null> {
    const record = await this.getRevisionRecord(taskId)
    if (!record) {
      return null
    }
    const lines: string[] = [
      '## 之前的版本与用户反馈',
      `这是第 ${record.revision_count} 次修订。`,
      '### 上一版输出',
      record.previous_result ?? '（无上一版输出）',
      '### 用户反馈历史',
    ]
    record.user_feedback.forEach((feedback, index) => {
      lines.push(`${index + 1}. ${feedback}`)
    })
    return lines.join('\n')
  }

  /** 清理该任务的修订上下文（任务关闭/确认后调用）。 */
  async clearRevision(taskId: string): Promise<void> {
    await this.#ensureTable()
    await this.#db.run((raw) => {
      raw.prepare('DELETE FROM revision_records WHERE task_id = ?').run(taskId)
    })
  }


  /**
   * 列出修订记录（Web session/revisions 用）：updated_at 降序（最近优先），
   * 同刻以 task_id 降序兜底保证确定性。limit 由调用方（服务边界）校验后传入。
   */
  async listRevisions(limit = 50): Promise<RevisionRecord[]> {
    await this.#ensureTable()
    const rows = await this.#db.run((raw) => {
      return raw
        .prepare(
          `SELECT task_id, revision_count, previous_result, user_feedback, updated_at
           FROM revision_records
           ORDER BY updated_at DESC, task_id DESC
           LIMIT ?`,
        )
        .all(limit) as unknown as RevisionRow[]
    })
    return rows.map((row) => ({
      task_id: row.task_id,
      revision_count: row.revision_count,
      previous_result: row.previous_result,
      user_feedback: JSON.parse(row.user_feedback) as string[],
      updated_at: row.updated_at,
    }))
  }
}
