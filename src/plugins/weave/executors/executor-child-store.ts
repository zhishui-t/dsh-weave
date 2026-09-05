import type { WeaveDatabase } from '../persistence/weave-database.js'

/** executor_children 一行：sessionKey → continuable 子代理句柄。 */
export interface ExecutorChildRow {
  sessionKey: string
  executor: string
  childId: string
}

/**
 * provider 侧持久化视面（结构化最小接口）：dsh-subagent-executor-provider 只依赖此
 * 形状，测试可注入内存替身；生产由 ExecutorChildStore（core.db）实现。
 */
export interface ExecutorChildPersistence {
  /** upsert 一条映射（同 sessionKey 复用同一子代理，后者胜）。失败上抛。 */
  record(row: ExecutorChildRow): Promise<void>
  /** 启动时全量加载（provider hydrateChildren 种内存 Map）。失败上抛。 */
  load(): Promise<ExecutorChildRow[]>
}

/**
 * executor_children（core.db v3）访问器：continuable 子代理映射的持久镜像。
 * 用途：宿主/插件重启后 recovery 恢复对账——RUNNING 任务的 sessionKey 命中
 * child 记录即「子代理可续」，不再一律判死（对照官方 agent-team roster 对账）。
 * 全部经 WeaveDatabase 单写者队列；SQL 失败上抛（provider 侧降级为纯内存行为，
 * 恢复对账侧降级为旧「一律 FAILED」行为，均不阻断主链路）。
 */
export class ExecutorChildStore implements ExecutorChildPersistence {
  readonly #db: WeaveDatabase

  constructor(db: WeaveDatabase) {
    this.#db = db
  }

  async load(): Promise<ExecutorChildRow[]> {
    return this.#db.run((raw) => {
      const rows = raw
        .prepare('SELECT session_key, executor, child_id FROM executor_children ORDER BY session_key')
        .all() as Array<{ session_key: string; executor: string; child_id: string }>
      return rows.map((row) => ({ sessionKey: row.session_key, executor: row.executor, childId: row.child_id }))
    })
  }

  async record(row: ExecutorChildRow): Promise<void> {
    await this.#db.run((raw) => {
      raw
        .prepare(
          `INSERT INTO executor_children (session_key, executor, child_id, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_key) DO UPDATE SET
             executor = excluded.executor,
             child_id = excluded.child_id,
             updated_at = excluded.updated_at`,
        )
        .run(row.sessionKey, row.executor, row.childId, new Date().toISOString())
    })
  }

  async remove(sessionKey: string): Promise<void> {
    await this.#db.run((raw) => {
      raw.prepare('DELETE FROM executor_children WHERE session_key = ?').run(sessionKey)
    })
  }
}
