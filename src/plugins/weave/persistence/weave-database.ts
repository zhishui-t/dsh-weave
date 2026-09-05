import { DatabaseSync } from 'node:sqlite'
import { SingleWriterQueue } from './single-writer-queue.js'

export interface DatabaseSchema {
  /** 结构版本号，写入 PRAGMA user_version */
  version: number
  /** 建表/迁移语句（幂等，如 CREATE TABLE IF NOT EXISTS ...） */
  statements: DatabaseSchemaStatement[]
}

/**
 * 迁移语句：纯 SQL 字符串，或带执行条件的对象。
 * 条件语句用于「存量库补列」类迁移——CREATE TABLE IF NOT EXISTS 对已存在的表
 * 是 no-op，而 ALTER TABLE ADD COLUMN 在列已存在时会抛错，必须按谓词守卫。
 */
export type DatabaseSchemaStatement =
  | string
  | {
      sql: string
      /** 返回 true 才执行 sql；谓词拿到底层 DatabaseSync 连接。 */
      when: (db: DatabaseSync) => boolean
    }

export interface WeaveDatabaseOptions {
  /** 数据库文件路径；':memory:' 表示内存库（测试隔离） */
  path: string
  /** 单写者队列；不传则本库自建（WeavePersistence 会让所有库共享同一个） */
  queue?: SingleWriterQueue
  /** 表结构；不传则不执行建表 */
  schema?: DatabaseSchema
  /** 是否开启 WAL（默认 true；:memory: 自动跳过，journal_mode 保持 memory） */
  wal?: boolean
  /** busy_timeout 毫秒，默认 5000 */
  busyTimeoutMs?: number
  /** 额外 PRAGMA，如 { 'cache_size': '-20000' } */
  pragmas?: Record<string, string>
}

export interface TableColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 单个 SQLite 数据库连接封装：WAL 配置、结构迁移（PRAGMA user_version）、
 * 写操作通过 SingleWriterQueue 串行化。
 */
export class WeaveDatabase {
  readonly path: string
  readonly isMemory: boolean
  readonly queue: SingleWriterQueue
  #db: DatabaseSync
  #open = true

  constructor(options: WeaveDatabaseOptions) {
    this.path = options.path
    this.isMemory = options.path === ':memory:'
    this.queue = options.queue ?? new SingleWriterQueue()
    this.#db = new DatabaseSync(this.path)
    this.#applyPragmas(options)
    if (options.schema) {
      this.migrate(options.schema)
    }
  }

  #applyPragmas(options: WeaveDatabaseOptions): void {
    const wal = options.wal ?? true
    // WAL 仅对文件库有效；:memory: 保持 journal_mode=memory
    if (wal && !this.isMemory) {
      this.#db.prepare('PRAGMA journal_mode = WAL').get()
    }
    this.#db.exec('PRAGMA synchronous = NORMAL')
    this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
    this.#db.exec('PRAGMA foreign_keys = ON')
    for (const [name, value] of Object.entries(options.pragmas ?? {})) {
      this.#db.exec(`PRAGMA ${name} = ${value}`)
    }
  }

  /** 应用结构迁移（幂等）：user_version 小于 schema.version 时执行建表语句并升级版本。 */
  migrate(schema: DatabaseSchema): void {
    this.#assertOpen()
    if (this.userVersion() >= schema.version) {
      // 已达版本：仍评估自愈性条件语句（when 谓词幂等——列在则跳过，正常库零执行）。
      // 兜住「同版本分批补列」形态：v3 曾分两批落库（write_scopes 与 revision/attempt_token），
      // 仅前批迁移过的库 user_version 已达 3，版本门不再放行——运行时引用缺列即
      // `no such column`（终审实测）。条件 ALTER 本就为此设计，挪出版本门即可自愈。
      for (const statement of schema.statements) {
        if (typeof statement !== 'string' && statement.when(this.#db)) {
          this.#db.exec(statement.sql)
        }
      }
      return
    }
    for (const statement of schema.statements) {
      if (typeof statement === 'string') {
        this.#db.exec(statement)
        continue
      }
      if (statement.when(this.#db)) {
        this.#db.exec(statement.sql)
      }
    }
    this.#db.exec(`PRAGMA user_version = ${schema.version}`)
  }

  /** 通过单写者队列串行执行写操作（write 可为同步或异步）。 */
  run<T>(write: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      this.#assertOpen()
      return write(this.#db)
    })
  }

  /** 只读 PRAGMA 查询（如 journal_mode / user_version）。 */
  pragma(name: string): Record<string, unknown> | undefined {
    this.#assertOpen()
    return this.#db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  }

  /** 当前结构版本（PRAGMA user_version）。 */
  userVersion(): number {
    const row = this.pragma('user_version') as { user_version: number } | undefined
    return row?.user_version ?? 0
  }

  /** 当前 journal_mode（'wal' | 'memory' | ...）。 */
  journalMode(): string {
    const row = this.pragma('journal_mode') as { journal_mode: string } | undefined
    return row?.journal_mode ?? ''
  }

  /** 库内用户表清单（不含 sqlite_* 内部表）。 */
  tables(): string[] {
    this.#assertOpen()
    const rows = this.#db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
    return rows.map((r) => r.name)
  }

  /** PRAGMA table_info 列信息。 */
  columns(table: string): TableColumnInfo[] {
    if (!IDENTIFIER_RE.test(table)) {
      throw new Error(`非法表名: ${table}`)
    }
    this.#assertOpen()
    return this.#db.prepare(`PRAGMA table_info("${table}")`).all() as unknown as TableColumnInfo[]
  }

  /** 底层 DatabaseSync（高级/只读用途；写操作请走 run()）。 */
  get raw(): DatabaseSync {
    this.#assertOpen()
    return this.#db
  }

  close(): void {
    if (!this.#open) {
      return
    }
    this.#db.close()
    this.#open = false
  }

  #assertOpen(): void {
    if (!this.#open) {
      throw new Error(`数据库已关闭: ${this.path}`)
    }
  }
}
