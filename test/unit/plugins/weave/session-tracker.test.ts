import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPersistence, type WeavePersistence } from '../../../../src/plugins/weave/persistence/index.js'
import { SessionTracker, type RevisionRecord } from '../../../../src/plugins/weave/scheduling/session-tracker.js'

const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

describe('SessionTracker（:memory: 隔离）', () => {
  let p: WeavePersistence
  let tracker: SessionTracker

  beforeAll(() => {
    p = openPersistence({ inMemory: true })
    tracker = new SessionTracker(p.feedback)
  })

  afterAll(() => {
    p.close()
  })

  it('recordRevision 创建记录：count=1、feedback 历史、previous_result、updated_at 为 ISO 时间', async () => {
    await tracker.recordRevision('t-rec-1', '改成手机号验证码', 'v1 输出摘要')

    const record = await tracker.getRevisionRecord('t-rec-1')
    expect(record).not.toBeNull()
    expect(record).toMatchObject({
      task_id: 't-rec-1',
      revision_count: 1,
      previous_result: 'v1 输出摘要',
      user_feedback: ['改成手机号验证码'],
    })
    expect(isoRe.test(record!.updated_at)).toBe(true)
  })

  it('重复 recordRevision：count 递增、反馈追加、previous_result 替换为最新、旧反馈保留', async () => {
    await tracker.recordRevision('t-rec-2', '第一轮：改成手机号验证码', 'v1 输出摘要')
    await tracker.recordRevision('t-rec-2', '第二轮：再加邮箱校验', 'v2 输出摘要')

    const record = await tracker.getRevisionRecord('t-rec-2')
    expect(record).toMatchObject({
      task_id: 't-rec-2',
      revision_count: 2,
      previous_result: 'v2 输出摘要',
      user_feedback: ['第一轮：改成手机号验证码', '第二轮：再加邮箱校验'],
    })
  })

  it('getRevisionRecord：无记录返回 null', async () => {
    expect(await tracker.getRevisionRecord('t-rec-none')).toBeNull()
  })

  it('getRevisionContext：无记录返回 null', async () => {
    expect(await tracker.getRevisionContext('t-rec-none')).toBeNull()
  })

  it('getRevisionContext：包含标题、修订次数、上一版输出与编号反馈历史', async () => {
    await tracker.recordRevision('t-ctx-1', '反馈一', 'v1 摘要')
    await tracker.recordRevision('t-ctx-1', '反馈二', 'v2 摘要')

    const context = await tracker.getRevisionContext('t-ctx-1')
    expect(context).not.toBeNull()
    expect(context).toContain('## 之前的版本与用户反馈')
    expect(context).toContain('这是第 2 次修订。')
    expect(context).toContain('### 上一版输出')
    expect(context).toContain('v2 摘要')
    expect(context).toContain('### 用户反馈历史')
    expect(context).toContain('1. 反馈一')
    expect(context).toContain('2. 反馈二')
  })

  it('clearRevision：清理后 getRevisionRecord / getRevisionContext 均返回 null', async () => {
    await tracker.recordRevision('t-clear-1', '反馈', 'v1 摘要')

    await tracker.clearRevision('t-clear-1')

    expect(await tracker.getRevisionRecord('t-clear-1')).toBeNull()
    expect(await tracker.getRevisionContext('t-clear-1')).toBeNull()
  })

  it('任务间隔离：记录 A 不影响 B；清理 A 不影响 B（无跨任务状态残留）', async () => {
    await tracker.recordRevision('t-iso-a', 'A 的反馈', 'A 的上一版')
    expect(await tracker.getRevisionContext('t-iso-b')).toBeNull()

    await tracker.recordRevision('t-iso-b', 'B 的反馈', 'B 的上一版')
    const a = await tracker.getRevisionRecord('t-iso-a')
    const b = await tracker.getRevisionRecord('t-iso-b')
    expect(a?.previous_result).toBe('A 的上一版')
    expect(b?.previous_result).toBe('B 的上一版')
    expect(a?.user_feedback).toEqual(['A 的反馈'])
    expect(b?.user_feedback).toEqual(['B 的反馈'])

    await tracker.clearRevision('t-iso-a')
    expect(await tracker.getRevisionRecord('t-iso-a')).toBeNull()
    expect((await tracker.getRevisionRecord('t-iso-b'))?.revision_count).toBe(1)
  })

  it('并发 recordRevision：经单写者队列串行化，无丢失', async () => {
    await Promise.all([
      tracker.recordRevision('t-conc-1', '并发反馈-1', 'v0 摘要'),
      tracker.recordRevision('t-conc-1', '并发反馈-2', 'v1 摘要'),
    ])

    const record = await tracker.getRevisionRecord('t-conc-1')
    expect(record?.revision_count).toBe(2)
    expect(record?.user_feedback).toEqual(['并发反馈-1', '并发反馈-2'])
  })
})

describe('SessionTracker（文件库持久化）', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'weave-session-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('关闭后重开：修订上下文仍在（持久化符合 TDD）', async () => {
    const p1 = openPersistence({ stateDir: dir })
    const t1 = new SessionTracker(p1.feedback)
    await t1.recordRevision('t-persist-1', '持久化反馈', '持久化上一版')
    p1.close()

    const p2 = openPersistence({ stateDir: dir })
    const t2 = new SessionTracker(p2.feedback)
    try {
      const record = await t2.getRevisionRecord('t-persist-1')
      expect(record).toMatchObject({
        task_id: 't-persist-1',
        revision_count: 1,
        previous_result: '持久化上一版',
        user_feedback: ['持久化反馈'],
      })
      expect(await t2.getRevisionContext('t-persist-1')).toContain('持久化上一版')
    } finally {
      p2.close()
    }
  })

  it('一个 SessionTracker 创建的 revision_records 表结构与 RevisionRecord 一致', async () => {
    const p = openPersistence({ stateDir: dir })
    const tracker = new SessionTracker(p.feedback)
    try {
      const columns = p.feedback.columns('revision_records')
      expect(columns.map((c) => c.name)).toEqual([
        'task_id',
        'revision_count',
        'previous_result',
        'user_feedback',
        'updated_at',
      ])
      expect(columns.find((c) => c.name === 'task_id')?.pk).toBe(1)
      expect(columns.find((c) => c.name === 'user_feedback')?.dflt_value).toBe("'[]'")
      expect(columns.find((c) => c.name === 'revision_count')?.dflt_value).toBe('0')

      // 记录类型符合 RevisionRecord 契约
      await tracker.recordRevision('t-schema-1', '反馈', '上一版')
      const row = await tracker.getRevisionRecord('t-schema-1')
      const typed: RevisionRecord | null = row
      expect(typed?.task_id).toBe('t-schema-1')
    } finally {
      p.close()
    }
  })
})
