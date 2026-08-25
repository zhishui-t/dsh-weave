import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog, AUDIT_EVENT_TYPES, AUDIT_EVENT_REQUIRED_FIELDS } from '../audit/index.js'
import { SingleWriterQueue } from '../persistence/single-writer-queue.js'

const mkAudit = (dir: string, now?: () => Date): AuditLog =>
  new AuditLog({ dir, queue: new SingleWriterQueue(), now, idFactory: () => 'evt-1' })

describe('AuditLog：核心事件写入与字段完整', () => {
  const withTmp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-audit-'))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('写入 task.status_changed 并生成 id/occurred_at，文件为 JSONL', async () => {
    await withTmp(async (dir) => {
      const audit = mkAudit(dir, () => new Date('2026-08-25T10:00:00.000Z'))
      const written = await audit.record({
        type: 'task.status_changed',
        task_id: 't-001',
        from: 'WAITING',
        to: 'RUNNING',
        by: 'scheduler',
      })
      expect(written.id).toBe('evt-1')
      expect(written.occurred_at).toBe('2026-08-25T10:00:00.000Z')
      expect(existsSync(join(dir, 'audit-2026-08-25.jsonl'))).toBe(true)
      const all = await audit.query()
      expect(all).toHaveLength(1)
      expect(all[0]).toMatchObject({ task_id: 't-001', from: 'WAITING', to: 'RUNNING', by: 'scheduler' })
    })
  })

  it('缺少必填字段抛 invalid_audit_event 且不落盘', async () => {
    await withTmp(async (dir) => {
      const audit = mkAudit(dir)
      await expect(
        audit.record({ type: 'task.status_changed', task_id: 'x', from: 'WAITING', to: 'RUNNING' } as never),
      ).rejects.toMatchObject({ code: 'invalid_audit_event' })
      await expect(
        audit.record({ type: 'ban.created', ban_id: 'b1' } as never),
      ).rejects.toMatchObject({
        code: 'invalid_audit_event',
        details: expect.objectContaining({ missing: expect.arrayContaining(['scope', 'entity_key']) }),
      })
      expect(await audit.query()).toHaveLength(0)
    })
  })

  it('未知事件类型拒绝', async () => {
    await withTmp(async (dir) => {
      const audit = mkAudit(dir)
      await expect(
        audit.record({ type: 'unknown.event' } as never),
      ).rejects.toMatchObject({ code: 'invalid_audit_event' })
      expect(await audit.query()).toHaveLength(0)
    })
  })

  it('AC-TASK-002：非法状态转移（WAITING→CLOSED）拒绝写入', async () => {
    await withTmp(async (dir) => {
      const audit = mkAudit(dir)
      await expect(
        audit.record({ type: 'task.status_changed', task_id: 't-x', from: 'WAITING', to: 'CLOSED', by: 's' } as never),
      ).rejects.toMatchObject({ code: 'invalid_status_transition' })
      expect(await audit.query()).toHaveLength(0)
    })
  })

  it('合法状态转移（RUNNING→COMPLETED）允许写入', async () => {
    await withTmp(async (dir) => {
      const audit = mkAudit(dir)
      await audit.record({ type: 'task.status_changed', task_id: 't-ok', from: 'RUNNING', to: 'COMPLETED', by: 's' })
      expect(await audit.query()).toHaveLength(1)
    })
  })

  it('全部 8 类核心事件可写入且字段完整（任务/反馈/知识/导入/熔断/团队）', async () => {
    await withTmp(async (dir) => {
      const audit = mkAudit(dir)
      await audit.record({ type: 'task.status_changed', task_id: 't-001', from: 'WAITING', to: 'RUNNING', by: 's' })
      await audit.record({ type: 'task.feedback_received', task_id: 't-001', revision_count: 1 })
      await audit.record({ type: 'knowledge.status_changed', knowledge_id: 'k-001', from: 'candidate', to: 'active' })
      await audit.record({ type: 'knowledge.superseded', new_id: 'k-002', old_id: 'k-001', reason: 'replaced-by-new' })
      await audit.record({ type: 'import.confirmed', job_id: 'imp-001', candidate_id: 'k-003' })
      await audit.record({ type: 'ban.created', ban_id: 'b-001', scope: 'agent', entity_key: 'deepseek' })
      await audit.record({ type: 'ban.resolved', ban_id: 'b-001', scope: 'agent', entity_key: 'deepseek' })
      await audit.record({ type: 'team.switched', session_id: 'sess-1', from_team: 'a', to_team: 'b' })
      // 核心 8 类（recovery.* 为恢复模块扩展的事件类型，不在核心契约内）
      const coreTypes = AUDIT_EVENT_TYPES.filter((t) => !t.startsWith('recovery.'))
      const events = await audit.query({ types: [...coreTypes] })
      expect(events).toHaveLength(8)
      const types = new Set(events.map((e) => e.type))
      for (const t of coreTypes) expect(types.has(t)).toBe(true)
      for (const t of coreTypes) {
        expect(AUDIT_EVENT_REQUIRED_FIELDS[t].length).toBeGreaterThan(0)
      }
    })
  })

  it('并发写入串行化：20 条事件全部落盘且每行都是合法 JSON', async () => {
    await withTmp(async (dir) => {
      const audit = mkAudit(dir)
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          audit.record({ type: 'task.status_changed', task_id: `c-${i}`, from: 'WAITING', to: 'RUNNING', by: 's' }),
        ),
      )
      const events = await audit.query({ types: ['task.status_changed'] })
      expect(events).toHaveLength(20)
      const ids = new Set(events.map((e) => (e as { task_id: string }).task_id))
      expect(ids.size).toBe(20)
    })
  })
})

describe('AuditLog：查询入口', () => {
  let dir: string
  let audit: AuditLog
  const now = (i: number): string => `2026-08-25T10:0${i}:00.000Z`

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'weave-audit-q-'))
    audit = new AuditLog({ dir, queue: new SingleWriterQueue(), idFactory: (() => { let n = 0; return () => `q-${++n}` })() })
    for (let i = 1; i <= 3; i++) {
      await audit.record({ type: 'task.status_changed', task_id: 't-aaa', from: 'WAITING', to: 'RUNNING', by: 's', occurred_at: now(i) })
    }
    await audit.record({ type: 'task.status_changed', task_id: 't-bbb', from: 'RUNNING', to: 'COMPLETED', by: 's', occurred_at: now(4) })
    await audit.record({ type: 'team.switched', session_id: 'sess-q', from_team: 'a', to_team: 'b', occurred_at: now(5) })
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('无过滤返回全部且默认按时间倒序', async () => {
    const all = await audit.query()
    expect(all).toHaveLength(5)
    expect(all[0]?.occurred_at).toBe(now(5))
    expect(all[4]?.occurred_at).toBe(now(1))
  })

  it('按 taskId 过滤', async () => {
    const events = await audit.query({ taskId: 't-aaa' })
    expect(events).toHaveLength(3)
    expect(events.every((e) => (e as { task_id: string }).task_id === 't-aaa')).toBe(true)
  })

  it('按类型过滤（types）与 sessionId 过滤', async () => {
    const byType = await audit.query({ types: ['team.switched'] })
    expect(byType).toHaveLength(1)
    const bySession = await audit.query({ sessionId: 'sess-q' })
    expect(bySession).toHaveLength(1)
  })

  it('时间范围过滤（from/to 含边界）', async () => {
    const events = await audit.query({ from: now(2), to: now(3) })
    expect(events.map((e) => e.occurred_at).sort()).toEqual([now(2), now(3)])
  })

  it('limit + order=asc', async () => {
    const events = await audit.query({ order: 'asc', limit: 2 })
    expect(events.map((e) => e.occurred_at)).toEqual([now(1), now(2)])
  })

  it('跨实例持久化：新 AuditLog 实例可查询到既有事件（审计查询入口）', async () => {
    const reopened = new AuditLog({ dir, queue: new SingleWriterQueue() })
    const events = await reopened.query({ taskId: 't-bbb' })
    expect(events).toHaveLength(1)
    expect((events[0] as { task_id: string }).task_id).toBe('t-bbb')
  })

  it('库不存在时 query 返回空数组（不抛错）', async () => {
    const empty = new AuditLog({ dir: join(dir, 'no-such-subdir'), queue: new SingleWriterQueue() })
    expect(await empty.query()).toEqual([])
  })
})
