import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPersistence, type WeavePersistence } from '../persistence/index.js'
import { AuditLog } from '../audit/audit-log.js'
import { KnowledgeStore } from '../knowledge-model.js'
import { RecoveryService } from '../recovery.js'

const insertTask = async (
  p: WeavePersistence,
  id: string,
  status: string,
  errorType: string | null = null,
  updatedAt = '2026-08-25T00:00:00.000Z',
): Promise<void> =>
  p.tasks.run((raw) => {
    raw
      .prepare(
        `INSERT INTO tasks (id, session_id, team_id, project_id, version, description, status, error_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, 'sess-1', 'team-1', 'proj-1', 'v1', `desc-${id}`, status, errorType, '2026-08-25T00:00:00.000Z', updatedAt)
  })

const insertImport = async (p: WeavePersistence, id: string, status: string): Promise<void> =>
  p.imports.run((raw) => {
    raw
      .prepare(
        `INSERT INTO import_jobs (id, original_filename, file_type, file_path, status, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, `${id}.pdf`, 'pdf', `/tmp/${id}.pdf`, status, 'project_only', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z')
  })

const taskRow = async (p: WeavePersistence, id: string): Promise<{ status: string; error_type: string | null }> =>
  p.tasks.run((raw) => {
    const row = raw.prepare('SELECT status, error_type FROM tasks WHERE id = ?').get(id) as
      | { status: string; error_type: string | null }
      | undefined
    if (!row) throw new Error(`task missing: ${id}`)
    return row
  })

const jobRow = async (p: WeavePersistence, id: string): Promise<{ status: string; error_message: string | null }> =>
  p.imports.run((raw) => {
    const row = raw.prepare('SELECT status, error_message FROM import_jobs WHERE id = ?').get(id) as
      | { status: string; error_message: string | null }
      | undefined
    if (!row) throw new Error(`job missing: ${id}`)
    return row
  })

const knowledgeStatus = async (p: WeavePersistence, id: string): Promise<string> =>
  p.knowledgeMeta.run((raw) => {
    const row = raw.prepare('SELECT status FROM knowledge_meta WHERE id = ?').get(id) as
      | { status: string }
      | undefined
    if (!row) throw new Error(`meta missing: ${id}`)
    return row.status
  })

describe('RecoveryService：任务修复（SDD 6.6 / AC-RECOVERY-001）', () => {
  let root: string
  let p: WeavePersistence
  let audit: AuditLog
  let recovery: RecoveryService

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-recovery-tasks-'))
    p = openPersistence({ inMemory: true })
    audit = new AuditLog({ dir: join(root, 'audit') })
    recovery = new RecoveryService({
      tasksDb: p.tasks,
      importsDb: p.imports,
      knowledgeMetaDb: p.knowledgeMeta,
      knowledgeRoot: join(root, 'knowledge'),
      audit,
    })
  })

  afterAll(() => {
    p.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('RUNNING/REVISION_RUNNING → FAILED（error_type=crash_recovery）；其它状态不动；幂等', async () => {
    await insertTask(p, 't-running', 'RUNNING')
    await insertTask(p, 't-rev', 'REVISION_RUNNING')
    await insertTask(p, 't-running-failed', 'RUNNING', 'timeout')
    await insertTask(p, 't-completed', 'COMPLETED')
    await insertTask(p, 't-failed', 'FAILED', 'execution_failed')
    await insertTask(p, 't-waiting', 'WAITING')

    const report = await recovery.repairTasks()
    expect(report.scanned).toBe(3) // RUNNING ×2 + REVISION_RUNNING（t-running-failed 带 error_type 也修复）
    expect(report.repaired).toBe(3)
    expect(report.actions).toHaveLength(3)

    expect(await taskRow(p, 't-running')).toMatchObject({ status: 'FAILED', error_type: 'crash_recovery' })
    expect(await taskRow(p, 't-rev')).toMatchObject({ status: 'FAILED', error_type: 'crash_recovery' })
    // 已有 error_type 的 RUNNING 任务：COALESCE 保留原值
    expect(await taskRow(p, 't-running-failed')).toMatchObject({ status: 'FAILED', error_type: 'timeout' })
    expect(await taskRow(p, 't-completed')).toMatchObject({ status: 'COMPLETED' })
    expect(await taskRow(p, 't-failed')).toMatchObject({ status: 'FAILED' })
    expect(await taskRow(p, 't-waiting')).toMatchObject({ status: 'WAITING' })

    // 幂等：第二次不再修复
    const again = await recovery.repairTasks()
    expect(again.repaired).toBe(0)
    expect(again.scanned).toBe(0)
  })

  it('修复动作写入审计（recovery.task_repaired，含 from/to/reason）', async () => {
    const events = await audit.query({ types: ['recovery.task_repaired'] })
    expect(events).toHaveLength(3)
    for (const event of events) {
      const e = event as unknown as Record<string, unknown>
      expect(['RUNNING', 'REVISION_RUNNING']).toContain(e.from)
      expect(e.to).toBe('FAILED')
      expect(typeof e.reason).toBe('string')
    }
  })
})

describe('RecoveryService：导入任务恢复（SDD 6.6）', () => {
  let root: string
  let p: WeavePersistence
  let audit: AuditLog
  let recovery: RecoveryService

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-recovery-imports-'))
    p = openPersistence({ inMemory: true })
    audit = new AuditLog({ dir: join(root, 'audit') })
    recovery = new RecoveryService({
      tasksDb: p.tasks,
      importsDb: p.imports,
      knowledgeMetaDb: p.knowledgeMeta,
      knowledgeRoot: join(root, 'knowledge'),
      audit,
    })
  })

  afterAll(() => {
    p.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('全部非终态 → failed + 可读 error_message；终态不动；幂等', async () => {
    for (const status of ['uploaded', 'converting', 'converted', 'previewing', 'reviewing']) {
      await insertImport(p, `imp-${status}`, status)
    }
    await insertImport(p, 'imp-failed', 'failed')
    await insertImport(p, 'imp-cancelled', 'cancelled')
    await insertImport(p, 'imp-confirmed', 'confirmed')

    const report = await recovery.repairImports()
    expect(report.repaired).toBe(5)

    for (const status of ['uploaded', 'converting', 'converted', 'previewing', 'reviewing']) {
      const row = await jobRow(p, `imp-${status}`)
      expect(row.status).toBe('failed')
      expect(row.error_message).toContain('崩溃恢复')
    }
    expect((await jobRow(p, 'imp-failed')).status).toBe('failed')
    expect((await jobRow(p, 'imp-cancelled')).status).toBe('cancelled')
    expect((await jobRow(p, 'imp-confirmed')).status).toBe('confirmed')

    const again = await recovery.repairImports()
    expect(again.repaired).toBe(0)

    const events = await audit.query({ types: ['recovery.import_repaired'] })
    expect(events).toHaveLength(5)
  })
})

describe('RecoveryService：知识元数据一致性（AC-RECOVERY-001）', () => {
  let root: string
  let knowledgeRoot: string
  let p: WeavePersistence
  let audit: AuditLog
  let store: KnowledgeStore
  let recovery: RecoveryService

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-recovery-kb-'))
    knowledgeRoot = join(root, 'knowledge')
    p = openPersistence({ inMemory: true })
    audit = new AuditLog({ dir: join(root, 'audit') })
    store = new KnowledgeStore({ rootDir: knowledgeRoot, metaDb: p.knowledgeMeta })
    recovery = new RecoveryService({
      tasksDb: p.tasks,
      importsDb: p.imports,
      knowledgeMetaDb: p.knowledgeMeta,
      knowledgeRoot,
      audit,
    })
  })

  afterAll(() => {
    p.close()
    rmSync(root, { recursive: true, force: true })
  })

  const makeCandidate = async (filename: string): Promise<string> => {
    const meta = await store.createCandidate({
      layer: 'project',
      scope: { projectId: 'demo', version: 'v1' },
      filename,
      frontmatter: { title: '知识卡片', type: 'doc', visibility: 'project_only', tags: [] },
      body: '正文',
    })
    return meta.id
  }

  it('文件在 → 不动；文件丢 → deprecated + 审计；幂等', async () => {
    const ok = await makeCandidate('ok.md')
    const lost = await makeCandidate('lost.md')
    const lostActive = await makeCandidate('lost-active.md')
    await store.activate(lostActive, { confirmed: true })

    // 模拟崩溃丢文件
    rmSync(join(knowledgeRoot, '_agent', 'projects', 'demo', 'v1', 'lost.md'))
    rmSync(join(knowledgeRoot, '_agent', 'projects', 'demo', 'v1', 'lost-active.md'))

    const report = await recovery.repairKnowledgeMeta()
    expect(report.scanned).toBe(3)
    expect(report.repaired).toBe(2)
    expect(report.skipped).toBe(1)

    expect(await knowledgeStatus(p, ok)).toBe('candidate')
    expect(await knowledgeStatus(p, lost)).toBe('deprecated')
    expect(await knowledgeStatus(p, lostActive)).toBe('deprecated')

    const events = await audit.query({ types: ['knowledge.status_changed'] })
    expect(events).toHaveLength(2)

    const again = await recovery.repairKnowledgeMeta()
    // deprecated 行不再扫描；ok 文件仍在 → skipped
    expect(again.repaired).toBe(0)
    expect(again.scanned).toBe(1)
    expect(again.skipped).toBe(1)
  })
})

describe('RecoveryService：事务与审计容错（recoverAll 汇总）', () => {
  let root: string
  let p: WeavePersistence

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-recovery-all-'))
    p = openPersistence({ inMemory: true })
  })

  afterAll(() => {
    p.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('recoverAll 汇总三类报告；审计失败不阻断修复', async () => {
    // 构造一个"目录路径被文件占用"的审计目录 → mkdir 失败 → record 抛错
    const auditDir = join(root, 'audit')
    writeFileSync(auditDir, 'not a dir', 'utf8')
    const brokenAudit = new AuditLog({ dir: auditDir })

    const recovery = new RecoveryService({
      tasksDb: p.tasks,
      importsDb: p.imports,
      knowledgeMetaDb: p.knowledgeMeta,
      knowledgeRoot: join(root, 'knowledge'),
      audit: brokenAudit,
    })
    await insertTask(p, 't-crash', 'RUNNING')
    await insertImport(p, 'imp-crash', 'converting')

    const report = await recovery.recoverAll()
    expect(report.repaired).toBe(2)
    expect(report.auditFailed).toBe(2)
    expect(report.actions).toHaveLength(2)
    expect(await taskRow(p, 't-crash')).toMatchObject({ status: 'FAILED' })
    expect(await jobRow(p, 'imp-crash')).toMatchObject({ status: 'failed' })
  })

  it('事务失败（数据库已关闭）时 fail-close：修复拒绝且无部分写入', async () => {
    const recovery = new RecoveryService({
      tasksDb: p.tasks,
      importsDb: p.imports,
      knowledgeMetaDb: p.knowledgeMeta,
      knowledgeRoot: join(root, 'knowledge'),
    })
    await insertTask(p, 't-close', 'RUNNING')
    p.tasks.close()
    await expect(recovery.repairTasks()).rejects.toThrow(/已关闭/)
    expect(existsSync(join(root, 'knowledge'))).toBe(false) // 无副作用
  })
})
