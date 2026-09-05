import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SingleWriterQueue } from '../../../../src/plugins/weave/persistence/single-writer-queue.js'
import { DatabaseSync } from 'node:sqlite'
import { CORE_SCHEMA_VERSION, DEFAULT_SCHEMAS, TASKS_SCHEMA_VERSION } from '../../../../src/plugins/weave/persistence/schemas.js'
import { WeaveDatabase } from '../../../../src/plugins/weave/persistence/weave-database.js'
import { openPersistence } from '../../../../src/plugins/weave/persistence/index.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

const deferred = (): Deferred => {
  let resolve = (): void => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const countRows = (db: WeaveDatabase, sql: string, ...params: (string | number | bigint | null)[]): number => {
  const row = db.raw.prepare(sql).get(...params) as { n: number } | undefined
  return row?.n ?? 0
}

const insertTask = (db: WeaveDatabase, id: string): Promise<void> =>
  db.run(
    (raw) => {
      raw
        .prepare(
          `INSERT INTO tasks (id, session_id, team_id, project_id, version, description, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          'sess-1',
          'team-1',
          'proj-1',
          'v1',
          `desc-${id}`,
          'WAITING',
          '2026-08-25T00:00:00.000Z',
          '2026-08-25T00:00:00.000Z',
        )
    },
  )

describe('SingleWriterQueue', () => {
  it('FIFO：写任务按提交顺序串行执行并返回各自结果', async () => {
    const q = new SingleWriterQueue()
    const order: string[] = []
    const results = await Promise.all(
      [40, 20, 10].map((ms, i) =>
        q.run(async () => {
          await sleep(ms)
          order.push(`write-${i}`)
          return i
        }),
      ),
    )
    expect(results).toEqual([0, 1, 2])
    expect(order).toEqual(['write-0', 'write-1', 'write-2'])
  })

  it('同一时刻只有一个写任务在执行（串行化）', async () => {
    const q = new SingleWriterQueue()
    let active = 0
    let maxActive = 0
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        q.run(async () => {
          active++
          maxActive = Math.max(maxActive, active)
          await sleep(2)
          active--
          return i
        }),
      ),
    )
    expect(maxActive).toBe(1)
  })
})

describe('SingleWriterQueue（续）', () => {
  it('写任务异常传播给调用方，且不阻塞后续任务', async () => {
    const q = new SingleWriterQueue()
    const bad = q.run(async () => {
      throw new Error('boom')
    })
    await expect(bad).rejects.toThrow('boom')
    await expect(q.run(async () => 'after-bad')).resolves.toBe('after-bad')
  })

  it('size 反映排队/执行中任务数，完成后归零', async () => {
    const q = new SingleWriterQueue()
    const gate = deferred()
    const first = q.run(() => gate.promise)
    expect(q.size).toBe(1)
    const second = q.run(async () => 'x')
    expect(q.size).toBe(2)
    gate.resolve()
    await first
    await second
    expect(q.size).toBe(0)
  })

  it('drain 等待当前已提交任务全部清空', async () => {
    const q = new SingleWriterQueue()
    const gate = deferred()
    q.run(() => gate.promise)
    q.run(async () => 'queued')
    const drained = q.drain()
    gate.resolve()
    await drained
    expect(q.size).toBe(0)
  })
})

describe('WeaveDatabase（文件库 + WAL）', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-db-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('打开即生成库文件，启用 WAL，user_version=1 且核心表创建', () => {
    const path = join(dir, 'core.db')
    const db = new WeaveDatabase({ path, schema: DEFAULT_SCHEMAS.core })
    try {
      expect(existsSync(path)).toBe(true)
      expect(db.journalMode()).toBe('wal')
      expect(db.userVersion()).toBe(DEFAULT_SCHEMAS.core.version)
      expect(db.tables()).toEqual(expect.arrayContaining(['task_sequences', 'bans', 'failure_counters']))
    } finally {
      db.close()
    }
  })

  it('WAL 模式下写入后产生 -wal 辅助文件', async () => {
    const path = join(dir, 'tasks.db')
    const db = new WeaveDatabase({ path, schema: DEFAULT_SCHEMAS.tasks })
    try {
      expect(db.journalMode()).toBe('wal')
      await insertTask(db, 'wal-1')
      expect(existsSync(`${path}-wal`)).toBe(true)
      expect(existsSync(`${path}-shm`)).toBe(true)
    } finally {
      db.close()
    }
  })
})

describe('WeaveDatabase（续）', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-db-schema-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('tasks 表结构与 TDD 2.1.4 DDL 一致（26 列，v3 起含 write_scopes/revision/attempt_token）', () => {
    const db = new WeaveDatabase({ path: join(dir, 'tasks-schema.db'), schema: DEFAULT_SCHEMAS.tasks })
    try {
      const cols = db.columns('tasks')
      expect(cols.map((c) => c.name)).toEqual([
        'id', 'dag_id', 'session_id', 'team_id', 'project_id', 'version', 'description',
        'stage', 'dependencies', 'write_scopes', 'revision', 'attempt_token', 'assigned_agent', 'executor', 'status', 'revision_count',
        'max_revisions', 'feedback_timeout_seconds', 'feedback_expires_at', 'skip_override',
        'skip_reason', 'fail_count', 'result', 'error_type', 'created_at', 'updated_at',
      ])
      expect(cols.find((c) => c.name === 'id')?.pk).toBe(1)
      expect(cols.find((c) => c.name === 'status')?.notnull).toBe(1)
      expect(cols.find((c) => c.name === 'dependencies')?.dflt_value).toBe("'[]'")
      expect(cols.find((c) => c.name === 'write_scopes')?.dflt_value).toBe("'[]'")
      expect(cols.find((c) => c.name === 'revision')?.dflt_value).toBe('0')
    } finally {
      db.close()
    }
  })

  it('表默认值符合 TDD（revision_count=0 / max_revisions=5 / timeout=1800 / skip_override=0 / fail_count=0）', async () => {
    const db = new WeaveDatabase({ path: join(dir, 'tasks-defaults.db'), schema: DEFAULT_SCHEMAS.tasks })
    try {
      await insertTask(db, 't-defaults')
      const row = db.raw
        .prepare('SELECT revision_count, max_revisions, feedback_timeout_seconds, skip_override, fail_count, dependencies FROM tasks WHERE id = ?')
        .get('t-defaults') as Record<string, unknown>
      expect(row).toMatchObject({
        revision_count: 0,
        max_revisions: 5,
        feedback_timeout_seconds: 1800,
        skip_override: 0,
        fail_count: 0,
        dependencies: '[]',
      })
    } finally {
      db.close()
    }
  })

  it('bans 表 UNIQUE(scope, entity_key) 约束生效', async () => {
    const db = new WeaveDatabase({ path: join(dir, 'bans.db'), schema: DEFAULT_SCHEMAS.core })
    try {
      const insert = (id: string, scope: string, entity: string) =>
        db.run(
          (raw) =>
            raw
              .prepare(
                `INSERT INTO bans (id, scope, entity_key, banned_at, state) VALUES (?, ?, ?, '2026-08-25T00:00:00.000Z', 'BANNED')`,
              )
              .run(id, scope, entity),
        )
      await insert('b-1', 'agent', 'deepseek')
      await expect(insert('b-2', 'agent', 'deepseek')).rejects.toThrow(/UNIQUE constraint failed/)
      await expect(insert('b-3', 'agent', 'codex')).resolves.toMatchObject({ changes: 1 })
    } finally {
      db.close()
    }
  })

  it('结构迁移幂等：重复打开同库不报错、版本与表不变', () => {
    const path = join(dir, 'reopen.db')
    const first = new WeaveDatabase({ path, schema: DEFAULT_SCHEMAS.core })
    first.close()
    const second = new WeaveDatabase({ path, schema: DEFAULT_SCHEMAS.core })
    try {
      expect(second.userVersion()).toBe(DEFAULT_SCHEMAS.core.version)
      expect(second.tables()).toEqual(expect.arrayContaining(['task_sequences', 'bans', 'failure_counters']))
    } finally {
      second.close()
    }
  })

  it(':memory: 库不落盘且 journal_mode 保持 memory（测试隔离）', () => {
    const db = new WeaveDatabase({ path: ':memory:', schema: DEFAULT_SCHEMAS.core })
    try {
      expect(db.journalMode()).toBe('memory')
      expect(db.tables()).toEqual(expect.arrayContaining(['bans']))
    } finally {
      db.close()
    }
  })
})

describe('WeavePersistence', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-persist-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('按 TDD 2.7 目录模型创建 5 个库文件且全部 WAL', () => {
    const p = openPersistence({ stateDir: dir })
    try {
      for (const file of ['tasks.db', 'core.db', 'feedback.db', 'knowledge_meta.db', 'imports.db']) {
        expect(existsSync(join(dir, file))).toBe(true)
      }
      for (const db of p.dbs) {
        expect(db.journalMode()).toBe('wal')
      }
      expect(p.tasks.tables()).toEqual(['dags', 'edges', 'tasks'])  // HI-3：tasks.db 含 dags/edges（TDD §2.6.6/2.6.7）
      expect(p.core.tables()).toEqual(['bans', 'failure_counters', 'task_sequences', 'team_bindings'])  // HI-3/TDD 2.6.8
      expect(p.feedback.tables()).toEqual(['feedback_routes'])
      expect(p.knowledgeMeta.tables()).toEqual(['knowledge_meta'])
      expect(p.imports.tables()).toEqual(['import_jobs'])
    } finally {
      p.close()
    }
  })

  it(':memory: 模式完全隔离：写入一个实例不影响另一个', async () => {
    const p1 = openPersistence({ inMemory: true })
    const p2 = openPersistence({ inMemory: true })
    try {
      await insertTask(p1.tasks, 'm1')
      expect(countRows(p1.tasks, 'SELECT COUNT(*) AS n FROM tasks')).toBe(1)
      expect(countRows(p2.tasks, 'SELECT COUNT(*) AS n FROM tasks')).toBe(0)
      expect(p1.tasks.journalMode()).toBe('memory')
      expect(p2.tasks.journalMode()).toBe('memory')
    } finally {
      p1.close()
      p2.close()
    }
  })

  it('关闭后重开：文件库数据仍在', async () => {
    const p1 = openPersistence({ stateDir: dir })
    await insertTask(p1.tasks, 'persist-1')
    p1.close()

    const p2 = openPersistence({ stateDir: dir })
    try {
      const row = p2.tasks.raw
        .prepare('SELECT id, status FROM tasks WHERE id = ?')
        .get('persist-1') as Record<string, unknown>
      expect(row).toMatchObject({ id: 'persist-1', status: 'WAITING' })
    } finally {
      p2.close()
    }
  })

  it('并发写通过共享单写者队列串行化且无丢失', async () => {
    const p = openPersistence({ stateDir: dir })
    try {
      await Promise.all(
        Array.from({ length: 30 }, (_, i) => insertTask(p.tasks, `concurrent-${i}`)),
      )
      expect(countRows(p.tasks, 'SELECT COUNT(*) AS n FROM tasks WHERE id LIKE ?', 'concurrent-%')).toBe(30)
    } finally {
      p.close()
    }
  })
})

describe('DDL 对齐（t30：dag/edges/team_bindings 统一注册）', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-ddl-align-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('dags 表结构与 TDD 2.6.6 一致（dag_id 主键 + 8 列）', () => {
    const db = new WeaveDatabase({ path: join(dir, 'dags.db'), schema: DEFAULT_SCHEMAS.tasks })
    try {
      const cols = db.columns('dags')
      expect(cols.map((c) => c.name)).toEqual([
        'dag_id', 'team_id', 'project_id', 'version', 'difficulty', 'status', 'created_at', 'updated_at',
      ])
      expect(cols.find((c) => c.name === 'dag_id')?.pk).toBe(1)
      expect(cols.find((c) => c.name === 'status')?.dflt_value).toBe("'created'")
      expect(cols.find((c) => c.name === 'difficulty')?.notnull).toBe(1)
    } finally {
      db.close()
    }
  })

  it('edges 表结构与 TDD 2.6.7 一致（复合主键 dag_id+from+to）', () => {
    const db = new WeaveDatabase({ path: join(dir, 'edges.db'), schema: DEFAULT_SCHEMAS.tasks })
    try {
      const cols = db.columns('edges')
      expect(cols.map((c) => c.name)).toEqual(['dag_id', 'from_task_id', 'to_task_id'])
      expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
        'dag_id', 'from_task_id', 'to_task_id',
      ])
      for (const col of cols) {
        expect(col.notnull).toBe(1)
      }
    } finally {
      db.close()
    }
  })

  it('team_bindings 表结构与 TDD 2.6.8 一致（core.db v2 注册）', () => {
    const p = openPersistence({ stateDir: dir })
    try {
      expect(p.core.tables()).toContain('team_bindings')
      expect(p.core.userVersion()).toBe(CORE_SCHEMA_VERSION)
      const cols = p.core.columns('team_bindings')
      expect(cols.map((c) => c.name)).toEqual(['session_id', 'team_id', 'updated_at'])
      expect(cols.find((c) => c.name === 'session_id')?.pk).toBe(1)
      expect(cols.find((c) => c.name === 'team_id')?.notnull).toBe(1)
      expect(cols.find((c) => c.name === 'updated_at')?.notnull).toBe(1)
    } finally {
      p.close()
    }
  })

  it('tasks 新列 dag_id/stage NOT NULL DEFAULT（HI-3/HI-4，与早期编写器兼容）', async () => {
    const p = openPersistence({ stateDir: dir })
    try {
      const cols = p.tasks.columns('tasks')
      expect(cols.find((c) => c.name === 'dag_id')?.notnull).toBe(1)
      expect(cols.find((c) => c.name === 'dag_id')?.dflt_value).toBe("''")
      expect(cols.find((c) => c.name === 'stage')?.notnull).toBe(1)
      expect(cols.find((c) => c.name === 'stage')?.dflt_value).toBe("''")

      await insertTask(p.tasks, 't-ddl-defaults')
      const row = p.tasks.raw
        .prepare('SELECT dag_id, stage FROM tasks WHERE id = ?')
        .get('t-ddl-defaults') as Record<string, unknown>
      expect(row).toMatchObject({ dag_id: '', stage: '' })
    } finally {
      p.close()
    }
  })
})

describe('tasks.db v3 迁移：write_scopes 写域列', () => {
  let dir: string

  // v2 形态 tasks 建表语句（无 write_scopes；迁移测试夹具，勿改）
  const TASKS_TABLE_V2_DDL = `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    dag_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    description TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT '',
    dependencies TEXT DEFAULT '[]',
    assigned_agent TEXT,
    executor TEXT,
    status TEXT NOT NULL,
    revision_count INTEGER DEFAULT 0,
    max_revisions INTEGER DEFAULT 5,
    feedback_timeout_seconds INTEGER DEFAULT 1800,
    feedback_expires_at TEXT,
    skip_override INTEGER DEFAULT 0,
    skip_reason TEXT,
    fail_count INTEGER DEFAULT 0,
    result TEXT,
    error_type TEXT,
    created_at TEXT,
    updated_at TEXT
)`

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-v3-migrate-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('全新库：tasks 直接带 write_scopes（DEFAULT []），版本升到 v3', () => {
    const p = openPersistence({ stateDir: dir })
    try {
      expect(p.tasks.userVersion()).toBe(TASKS_SCHEMA_VERSION)
      const col = p.tasks.columns('tasks').find((c) => c.name === 'write_scopes')
      expect(col).toBeDefined()
      expect(col?.dflt_value).toBe("'[]'")
    } finally {
      p.close()
    }
  })

  it('存量 v2 库：条件 ALTER 补列，旧行回填 [] 且数据保留', () => {
    const legacyDir = join(dir, 'legacy')
    mkdirSync(legacyDir, { recursive: true })
    // 手工造一个 v2 形态的 tasks.db（无 write_scopes 列，user_version=2）
    const legacy = new DatabaseSync(join(legacyDir, 'tasks.db'))
    legacy.exec(TASKS_TABLE_V2_DDL)
    legacy.exec('PRAGMA user_version = 2')
    legacy
      .prepare(
        `INSERT INTO tasks (id, session_id, team_id, project_id, version, description, status, created_at, updated_at)
         VALUES ('t-legacy', 's', 'team', 'proj', 'v1', '存量任务', 'RUNNING', '2026-01-01', '2026-01-01')`,
      )
      .run()
    legacy.close()

    const p = openPersistence({ stateDir: legacyDir })
    try {
      expect(p.tasks.userVersion()).toBe(TASKS_SCHEMA_VERSION)
      expect(p.tasks.columns('tasks').map((c) => c.name)).toContain('write_scopes')
      const row = p.tasks.raw.prepare('SELECT status, write_scopes FROM tasks WHERE id = ?').get('t-legacy') as {
        status: string
        write_scopes: string
      }
      expect(row.status).toBe('RUNNING')
      expect(row.write_scopes).toBe('[]')
    } finally {
      p.close()
    }
  })
})

