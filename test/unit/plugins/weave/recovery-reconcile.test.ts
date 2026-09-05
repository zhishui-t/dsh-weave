import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPersistence, type WeavePersistence } from '../../../../src/plugins/weave/persistence/index.js'
import { AuditLog } from '../../../../src/plugins/weave/audit/audit-log.js'
import { RecoveryService } from '../../../../src/plugins/weave/scheduling/recovery.js'
import {
  DefaultTaskLivenessProbe,
  type TaskLivenessVerdict,
} from '../../../../src/plugins/weave/scheduling/task-liveness.js'

const insertRunningTask = async (
  p: WeavePersistence,
  id: string,
  overrides: { status?: string; assigned_agent?: string; executor?: string; attempt_token?: string } = {},
): Promise<void> =>
  p.tasks.run((raw) => {
    raw
      .prepare(
        `INSERT INTO tasks (id, session_id, team_id, project_id, version, assigned_agent, executor, attempt_token,
                            description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        'sess-1',
        'team-1',
        'proj-1',
        'v1',
        overrides.assigned_agent ?? 'developer-1',
        overrides.executor ?? 'spawn',
        overrides.attempt_token ?? null,
        `desc-${id}`,
        overrides.status ?? 'RUNNING',
        '2026-08-25T00:00:00.000Z',
        '2026-08-25T00:00:00.000Z',
      )
  })

const taskRow = async (p: WeavePersistence, id: string): Promise<{ status: string; error_type: string | null; attempt_token: string | null; revision: number }> =>
  p.tasks.run((raw) => {
    const row = raw.prepare('SELECT status, error_type, attempt_token, revision FROM tasks WHERE id = ?').get(id) as
      | { status: string; error_type: string | null; attempt_token: string | null; revision: number }
      | undefined
    if (!row) throw new Error(`task missing: ${id}`)
    return row
  })

const probeFor = (verdict: TaskLivenessVerdict | Error) => ({
  probeTask: async () => {
    if (verdict instanceof Error) throw verdict
    return verdict
  },
})

describe('RecoveryService 恢复对账（liveness 探针三分支）', () => {
  let root: string
  let p: WeavePersistence
  let audit: AuditLog
  let makeRecovery: (probe?: unknown) => RecoveryService

  // 每用例独立库/审计目录：保持 RUNNING 的任务不能跨用例泄漏进下一轮 repairTasks 扫描。
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-recovery-reconcile-'))
    p = openPersistence({ inMemory: true })
    audit = new AuditLog({ dir: join(root, 'audit') })
    makeRecovery = (probe?: unknown): RecoveryService =>
      new RecoveryService({
        tasksDb: p.tasks,
        importsDb: p.imports,
        knowledgeMetaDb: p.knowledgeMeta,
        knowledgeRoot: join(root, 'knowledge'),
        audit,
        liveness: probe as never,
      })
  })

  afterEach(() => {
    p.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('alive：子代理活着 → 保持 RUNNING，审计 recovery.task_reconciled，不发电不改写', async () => {
    await insertRunningTask(p, 't-alive', { attempt_token: 'tok-alive' })
    const report = await makeRecovery(probeFor({ verdict: 'alive', childId: 'child-1', detail: 'live in-process' })).repairTasks()
    expect(report.reconciled).toBe(1)
    expect(report.repaired).toBe(0)
    const row = await taskRow(p, 't-alive')
    expect(row.status).toBe('RUNNING')
    expect(row.attempt_token).toBe('tok-alive') // 保持 RUNNING：不作废句柄
    const events = await audit.query({ types: ['recovery.task_reconciled'] })
    const hit = events.find((e) => (e as unknown as Record<string, unknown>).task_id === 't-alive') as unknown as Record<string, unknown>
    expect(hit?.verdict).toBe('alive')
    expect(String(hit?.detail)).toContain('live in-process')
  })

  it('artifacts：会话有持久产物 → 保持 RUNNING 可续', async () => {
    await insertRunningTask(p, 't-artifacts')
    const report = await makeRecovery(probeFor({ verdict: 'artifacts', detail: 'acp session materialized' })).repairTasks()
    expect(report.reconciled).toBe(1)
    expect((await taskRow(p, 't-artifacts')).status).toBe('RUNNING')
    const events = await audit.query({ types: ['recovery.task_reconciled'] })
    expect(events.find((e) => (e as unknown as Record<string, unknown>).task_id === 't-artifacts')).toMatchObject({ verdict: 'artifacts' })
  })

  it('dead：两处皆无 → FAILED(crash_recovery)，作废 attempt token 并 revision+1', async () => {
    await insertRunningTask(p, 't-dead', { attempt_token: 'tok-dead' })
    const report = await makeRecovery(probeFor({ verdict: 'dead', detail: 'no record' })).repairTasks()
    expect(report.reconciled).toBe(0)
    expect(report.repaired).toBe(1)
    const row = await taskRow(p, 't-dead')
    expect(row.status).toBe('FAILED')
    expect(row.error_type).toBe('crash_recovery')
    expect(row.attempt_token).toBeNull()
    expect(row.revision).toBeGreaterThanOrEqual(1)
    const events = await audit.query({ types: ['recovery.task_repaired'] })
    const hit = events.find((e) => (e as unknown as Record<string, unknown>).task_id === 't-dead') as unknown as Record<string, unknown>
    expect(String(hit?.reason)).toContain('no record')
  })

  it('探针异常：保守回落 FAILED，detail 带异常原因（不静默）', async () => {
    await insertRunningTask(p, 't-probe-err')
    const report = await makeRecovery(probeFor(new Error('index io exploded'))).repairTasks()
    expect(report.repaired).toBe(1)
    expect((await taskRow(p, 't-probe-err')).status).toBe('FAILED')
    const events = await audit.query({ types: ['recovery.task_repaired'] })
    const hit = events.find((e) => (e as unknown as Record<string, unknown>).task_id === 't-probe-err') as unknown as Record<string, unknown>
    expect(String(hit?.reason)).toContain('liveness probe failed')
    expect(String(hit?.reason)).toContain('index io exploded')
  })

  it('混合批次：一活一死各走各路；探针缺省保持旧行为（一律 FAILED）', async () => {
    await insertRunningTask(p, 't-mix-alive')
    await insertRunningTask(p, 't-mix-dead')
      const report = await makeRecovery({
        probeTask: (input: { taskId: string }) =>
          input.taskId === 't-mix-alive'
            ? Promise.resolve({ verdict: 'alive', detail: 'live' } as TaskLivenessVerdict)
            : Promise.resolve({ verdict: 'dead', detail: 'gone' } as TaskLivenessVerdict),
      }).repairTasks()
    expect(report.reconciled).toBe(1)
    expect(report.repaired).toBe(1)
    expect((await taskRow(p, 't-mix-alive')).status).toBe('RUNNING')
    expect((await taskRow(p, 't-mix-dead')).status).toBe('FAILED')

    await insertRunningTask(p, 't-legacy', { status: 'REVISION_RUNNING' })
    const legacy = await makeRecovery(undefined).repairTasks()
    expect(legacy.reconciled).toBe(0)
    // 无探针 = 旧行为：t-legacy 连同上一轮被探针保活的 t-mix-alive 一起判死。
    expect(legacy.repaired).toBe(2)
    expect((await taskRow(p, 't-legacy')).status).toBe('FAILED')
  })
})

describe('DefaultTaskLivenessProbe 三分支判定矩阵', () => {
  const sessionKey = 'team-1:developer-1:proj-1:v1'
  const input = { taskId: 't1', executor: 'spawn', sessionId: 'sess-1', sessionKey }

  const makeProbe = (options: {
    children?: Array<{ sessionKey: string; executor: string; childId: string }>
    liveIds?: string[]
    treeIds?: Array<{ id: string; label?: string; mode?: string }>
    indexKeys?: Record<string, { acpSid: string; updatedAt: number }>
  }) =>
    new DefaultTaskLivenessProbe({
      children: {
        load: async () => options.children ?? [],
        record: async () => undefined,
      },
      subagents: {
        agents: { get: (id: string) => (options.liveIds?.includes(id) ? { id } : undefined) },
        ...(options.treeIds
          ? {
              listChildren: async () =>
                options.treeIds!.map((c) => ({ kind: 'child', mode: c.mode ?? 'continuable', id: c.id, label: c.label })),
            }
          : {}),
      },
      acpIndexFile: 'unused://injected-reader',
      readIndex: () => options.indexKeys ?? {},
    })

  it('进程内活子代理 → alive', async () => {
    const probe = makeProbe({ children: [{ sessionKey, executor: 'spawn', childId: 'c1' }], liveIds: ['c1'] })
    await expect(probe.probeTask(input)).resolves.toMatchObject({ verdict: 'alive', childId: 'c1' })
  })

  it('不活但持久会话树可查 → artifacts（可续）', async () => {
    const probe = makeProbe({
      children: [{ sessionKey, executor: 'spawn', childId: 'c2' }],
      treeIds: [{ id: 'c2', label: sessionKey }],
    })
    await expect(probe.probeTask(input)).resolves.toMatchObject({ verdict: 'artifacts', childId: 'c2' })
  })

  it('executor_children 无记录但 ACP 会话索引命中 → artifacts（acpSid 物化）', async () => {
    const probe = makeProbe({ indexKeys: { [sessionKey]: { acpSid: 'acp-123', updatedAt: 1 } } })
    await expect(probe.probeTask(input)).resolves.toMatchObject({ verdict: 'artifacts', detail: expect.stringContaining('acp-123') })
  })

  it('children 有记录但树不可查且无索引 → dead；完全无痕迹 → dead', async () => {
    const orphan = makeProbe({ children: [{ sessionKey, executor: 'spawn', childId: 'c3' }] })
    await expect(orphan.probeTask(input)).resolves.toMatchObject({ verdict: 'dead' })
    const empty = makeProbe({})
    await expect(empty.probeTask(input)).resolves.toMatchObject({ verdict: 'dead' })
  })
})
