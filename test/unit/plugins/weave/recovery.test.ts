import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPersistence, type WeavePersistence } from '../../../../src/plugins/weave/persistence/index.js'
import { AuditLog } from '../../../../src/plugins/weave/audit/audit-log.js'
import { RecoveryService } from '../../../../src/plugins/weave/scheduling/recovery.js'
import { TaskStatusNotifier } from '../../../../src/plugins/weave/scheduling/task-status-notifier.js'

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

const taskRow = async (p: WeavePersistence, id: string): Promise<{ status: string; error_type: string | null }> =>
  p.tasks.run((raw) => {
    const row = raw.prepare('SELECT status, error_type FROM tasks WHERE id = ?').get(id) as
      | { status: string; error_type: string | null }
      | undefined
    if (!row) throw new Error(`task missing: ${id}`)
    return row
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

  it('recoverAll 汇总任务报告；审计失败不阻断修复', async () => {
    // 构造一个"目录路径被文件占用"的审计目录 → mkdir 失败 → record 抛错
    const auditDir = join(root, 'audit')
    writeFileSync(auditDir, 'not a dir', 'utf8')
    const brokenAudit = new AuditLog({ dir: auditDir })

    const recovery = new RecoveryService({
      tasksDb: p.tasks,
      audit: brokenAudit,
    })
    await insertTask(p, 't-crash', 'RUNNING')

    const report = await recovery.recoverAll()
    expect(report.repaired).toBe(1)
    expect(report.auditFailed).toBe(1)
    expect(report.actions).toHaveLength(1)
    expect(await taskRow(p, 't-crash')).toMatchObject({ status: 'FAILED' })
  })

  it('事务失败（数据库已关闭）时 fail-close：修复拒绝且无部分写入', async () => {
    const recovery = new RecoveryService({
      tasksDb: p.tasks,
    })
    await insertTask(p, 't-close', 'RUNNING')
    p.tasks.close()
    await expect(recovery.repairTasks()).rejects.toThrow(/已关闭/)
  })
})

describe('RecoveryService 崩溃修复发电（doc/05 §6.4 P1-D 接线点 6）', () => {
  it('RUNNING→FAILED 修复发电：actor=recovery，sessionId/dagId 路由', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-recovery-notify-'))
    const p = openPersistence({ inMemory: true })
    const notified: Array<{ sessionId: string; text: string }> = []
    const recovery = new RecoveryService({
      tasksDb: p.tasks,
      audit: new AuditLog({ dir: join(root, 'audit') }),
      statusNotifier: new TaskStatusNotifier({
        notify: (sessionId, text) => notified.push({ sessionId, text }),
      }),
    })

    await insertTask(p, 't-notify', 'RUNNING')
    const report = await recovery.repairTasks()
    expect(report.repaired).toBe(1)
    expect(notified).toHaveLength(1)
    // recovery actor 不在回声抑制集合内：缺省即通知
    expect(notified[0]!.sessionId).toBe('sess-1')
    expect(notified[0]!.text).toContain('「desc-t-notify」RUNNING → FAILED（crash_recovery）')

    p.close()
    rmSync(root, { recursive: true, force: true })
  })
})
