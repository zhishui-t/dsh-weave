import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SingleWriterQueue } from './single-writer-queue.js'
import { DEFAULT_SCHEMAS } from './schemas.js'
import { WeaveDatabase } from './weave-database.js'

export interface PersistenceOptions {
  /** state 目录；不传默认 ~/.dsh/state（TDD 2.7 目录模型） */
  stateDir?: string
  /** true 时所有库使用 ':memory:'，不做任何落盘（测试隔离） */
  inMemory?: boolean
}

export const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'state')

/**
 * WeavePersistence — 按 TDD 2.7 目录模型管理 5 个 SQLite 库：
 * tasks.db / core.db / feedback.db / knowledge_meta.db / imports.db，
 * 全部开启 WAL 并通过同一个 SingleWriterQueue 串行化写操作。
 */
export class WeavePersistence {
  readonly stateDir: string
  readonly inMemory: boolean
  /** 全局单写者：所有库的写操作共享同一队列串行化 */
  readonly queue = new SingleWriterQueue()

  readonly tasks: WeaveDatabase
  readonly core: WeaveDatabase
  readonly feedback: WeaveDatabase
  readonly knowledgeMeta: WeaveDatabase
  readonly imports: WeaveDatabase

  constructor(options: PersistenceOptions = {}) {
    this.inMemory = options.inMemory ?? false
    this.stateDir = this.inMemory ? ':memory:' : (options.stateDir ?? DEFAULT_STATE_DIR)
    if (!this.inMemory) {
      mkdirSync(this.stateDir, { recursive: true })
    }

    const pathFor = (file: string): string =>
      this.inMemory ? ':memory:' : join(this.stateDir, file)

    const dbOptions = { queue: this.queue }
    this.tasks = new WeaveDatabase({
      ...dbOptions,
      path: pathFor('tasks.db'),
      schema: DEFAULT_SCHEMAS.tasks,
    })
    this.core = new WeaveDatabase({
      ...dbOptions,
      path: pathFor('core.db'),
      schema: DEFAULT_SCHEMAS.core,
    })
    this.feedback = new WeaveDatabase({
      ...dbOptions,
      path: pathFor('feedback.db'),
      schema: DEFAULT_SCHEMAS.feedback,
    })
    this.knowledgeMeta = new WeaveDatabase({
      ...dbOptions,
      path: pathFor('knowledge_meta.db'),
      schema: DEFAULT_SCHEMAS.knowledgeMeta,
    })
    this.imports = new WeaveDatabase({
      ...dbOptions,
      path: pathFor('imports.db'),
      schema: DEFAULT_SCHEMAS.imports,
    })
  }

  get dbs(): WeaveDatabase[] {
    return [this.tasks, this.core, this.feedback, this.knowledgeMeta, this.imports]
  }

  close(): void {
    for (const db of this.dbs) {
      db.close()
    }
  }
}

/** 便捷入口：openPersistence({ stateDir }) / openPersistence({ inMemory: true }) */
export const openPersistence = (options?: PersistenceOptions): WeavePersistence =>
  new WeavePersistence(options)
