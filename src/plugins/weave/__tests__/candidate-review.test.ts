/**
 * P0-KREVIEW-012 —— 候选知识审核测试（AC-KNOW-003 + FDD 4.6.3/4.6.4）。
 *
 * 覆盖：审核队列（按层过滤/顺序/标题标签）、approve 显式性（仅 candidate 可审、
 * 双确认层）、reject 不转正、supersede 旧文件保留、审计事件完整性、生命周期
 * candidate → active → deprecated | superseded。
 *
 * 运行：pnpm vitest run src/plugins/weave/__tests__/candidate-review.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openPersistence, type WeavePersistence } from '../persistence/index.js'
import { KnowledgeStore, type CreateCandidateInput } from '../knowledge/knowledge-model.js'
import { AuditLog, type AuditEvent } from '../audit/audit-log.js'
import { KnowledgeReviewService } from '../knowledge/knowledge-review.js'

interface Fixture {
  root: string
  p: WeavePersistence
  knowledge: KnowledgeStore
  audit: AuditLog
  review: KnowledgeReviewService
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'weave-kreview-'))
  const p = openPersistence({ inMemory: true })
  const knowledge = new KnowledgeStore({ rootDir: join(root, 'knowledge'), metaDb: p.knowledgeMeta })
  const audit = new AuditLog({ dir: join(root, 'audit') })
  const review = new KnowledgeReviewService({ knowledge, audit })
  return { root, p, knowledge, audit, review }
}

function closeFixture(f: Fixture): void {
  f.p.close()
  rmSync(f.root, { recursive: true, force: true })
}

function candidateInput(overrides: Partial<CreateCandidateInput> = {}): CreateCandidateInput {
  return {
    layer: 'project',
    scope: { projectId: 'demo', version: 'v1' },
    filename: 'guide.md',
    frontmatter: {
      title: '项目指南',
      type: 'doc',
      visibility: 'project_only',
      tags: ['设计', '指南'],
    },
    body: '# 项目指南\n\n正文内容。',
    ...overrides,
  }
}

async function seedCandidate(f: Fixture, overrides: Partial<CreateCandidateInput> = {}) {
  return f.knowledge.createCandidate(candidateInput(overrides))
}

const statusChangedOf = (events: AuditEvent[], knowledgeId: string) =>
  events.filter(
    (e): e is Extract<AuditEvent, { type: 'knowledge.status_changed' }> =>
      e.type === 'knowledge.status_changed' && e.knowledge_id === knowledgeId,
  )

describe('P0-KREVIEW：审核队列（FDD 4.6.3 前置）', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture()
  })
  afterAll(() => closeFixture(f))

  it('队列列出全部 candidate（created 升序），带标题/标签；可按 layer 过滤', async () => {
    await seedCandidate(f, { filename: 'a.md', frontmatter: { title: 'A 指南', type: 'doc', visibility: 'project_only', tags: ['a'] } })
    await seedCandidate(f, { filename: 'b.md', frontmatter: { title: 'B 指引', type: 'skill', visibility: 'project_only', tags: ['b'] } })
    await seedCandidate(f, {
      layer: 'role',
      scope: { roleId: 'designer' },
      filename: 'c.md',
      frontmatter: { title: 'C 规范', type: 'guide', visibility: 'role_only', tags: ['c'] },
    })

    const queue = await f.review.listQueue()
    expect(queue.length).toBe(3)
    expect(queue.map((q) => q.title)).toEqual(['A 指南', 'B 指引', 'C 规范'])
    expect(queue[0]!.tags).toEqual(['a'])
    expect(queue[2]!.meta.layer).toBe('role')

    const roleQueue = await f.review.listQueue({ layer: 'role' })
    expect(roleQueue.map((q) => q.title)).toEqual(['C 规范'])
    expect(await f.review.queueSize()).toBe(3)
  })
})

describe('P0-KREVIEW：approve —— candidate→active 只能显式审核（AC-KNOW-003）', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture()
  })
  afterAll(() => closeFixture(f))

  it('approve：candidate → active，文件 frontmatter 同步，队列移除，last_confirmed 写入', async () => {
    const meta = await seedCandidate(f)
    await f.review.approve(meta.id)

    const after = await f.knowledge.getMeta(meta.id)
    expect(after?.status).toBe('active')
    expect(after?.last_confirmed).not.toBeNull()
    expect(await f.review.queueSize()).toBe(0)

    const file = f.knowledge.getKnowledgeFile(meta.id)
    expect(file?.frontmatter.status).toBe('active')
    expect(file?.frontmatter.title).toBe('项目指南')
    expect(file?.body).toContain('正文内容')
  })

  it('approve 审计：knowledge.status_changed（candidate→active）恰好一条且字段完整', async () => {
    const meta = await seedCandidate(f, { filename: 'audit-approve.md', frontmatter: { title: '审计通过', type: 'doc', visibility: 'project_only', tags: [] } })
    await f.review.approve(meta.id)

    const events = (await f.audit.query({ types: ['knowledge.status_changed'], knowledgeId: meta.id })) as AuditEvent[]
    const mine = statusChangedOf(events, meta.id)
    expect(mine.length).toBe(1)
    expect(mine[0]!.from).toBe('candidate')
    expect(mine[0]!.to).toBe('active')
  })

  it('显式性：非 candidate（active/deprecated）approve 拒绝，不产生状态变更与审计', async () => {
    const meta = await seedCandidate(f, { filename: 'twice.md', frontmatter: { title: '重复审核', type: 'doc', visibility: 'project_only', tags: [] } })
    await f.review.approve(meta.id)
    await expect(f.review.approve(meta.id)).rejects.toMatchObject({ code: 'invalid_knowledge_status' })

    const after = await f.knowledge.getMeta(meta.id)
    expect(after?.status).toBe('active')
    const events = (await f.audit.query({ types: ['knowledge.status_changed'], knowledgeId: meta.id })) as AuditEvent[]
    expect(statusChangedOf(events, meta.id).length).toBe(1)

    // 未通过审核的下游写入防线（KnowledgeStore 层再次确认）：activate 必须显式 confirmed
    const fresh = await seedCandidate(f, { filename: 'guard.md', frontmatter: { title: '守卫', type: 'doc', visibility: 'project_only', tags: [] } })
    await expect(f.knowledge.activate(fresh.id, { confirmed: false })).rejects.toThrow(/显式确认/)
    expect((await f.knowledge.getMeta(fresh.id))?.status).toBe('candidate')
  })
})

describe('P0-KREVIEW：reject —— 不转正（FDD 4.6.3）', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture()
  })
  afterAll(() => closeFixture(f))

  it('reject：candidate → deprecated；不产生 active；文件保留且 frontmatter 同步', async () => {
    const meta = await seedCandidate(f, { filename: 'rejected.md', frontmatter: { title: '被驳回', type: 'doc', visibility: 'project_only', tags: [] } })
    await f.review.reject(meta.id)

    const after = await f.knowledge.getMeta(meta.id)
    expect(after?.status).toBe('deprecated')
    expect(await f.knowledge.listMeta({ status: 'active' })).toEqual([])

    const file = f.knowledge.getKnowledgeFile(meta.id)
    expect(file?.frontmatter.status).toBe('deprecated')
    expect(file?.body).toContain('正文内容')

    const events = (await f.audit.query({ types: ['knowledge.status_changed'], knowledgeId: meta.id })) as AuditEvent[]
    const mine = statusChangedOf(events, meta.id)
    expect(mine.length).toBe(1)
    expect(mine[0]!.from).toBe('candidate')
    expect(mine[0]!.to).toBe('deprecated')
  })
})

describe('P0-KREVIEW：supersede —— 旧文件保留（4.6.3 supersede）', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture()
  })
  afterAll(() => closeFixture(f))

  it('supersede：active → superseded；旧文件不删除、status=superseded、正文保留；审计含 new/old/reason', async () => {
    const oldMeta = await seedCandidate(f, { filename: 'old.md', frontmatter: { title: '旧版', type: 'doc', visibility: 'project_only', tags: [] } })
    await f.review.approve(oldMeta.id)

    const superseded = await f.review.supersede(oldMeta.id, 'new-id-123', '被新版取代')
    expect(superseded.status).toBe('superseded')
    expect(superseded.superseded_by).toBe('new-id-123')

    const absolute = join(f.knowledge.rootDir, oldMeta.path)
    expect(existsSync(absolute)).toBe(true)
    const raw = readFileSync(absolute, 'utf8')
    expect(raw).toContain('旧版')
    expect(raw).toContain('正文内容')

    const events = (await f.audit.query({ types: ['knowledge.superseded'] })) as AuditEvent[]
    expect(events.filter((e) => e.type === 'knowledge.superseded').length).toBe(1)
    const event = events.find((e) => e.type === 'knowledge.superseded' && (e as { old_id?: string }).old_id === oldMeta.id) as Extract<AuditEvent, { type: 'knowledge.superseded' }>
    expect(event.new_id).toBe('new-id-123')
    expect(event.old_id).toBe(oldMeta.id)
    expect(event.reason).toBe('被新版取代')
  })

  it('非 active 不可 supersede；未知 id 报 knowledge_not_found', async () => {
    const meta = await seedCandidate(f, { filename: 'cannot.md', frontmatter: { title: '不能替代', type: 'doc', visibility: 'project_only', tags: [] } })
    await expect(f.review.supersede(meta.id, 'x', 'r')).rejects.toMatchObject({ code: 'invalid_knowledge_status' })
    await expect(f.review.supersede('no-such-id', 'x', 'r')).rejects.toMatchObject({ code: 'knowledge_not_found' })
  })
})

describe('P0-KREVIEW：生命周期贯穿（AC-KNOW-003）', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture()
  })
  afterAll(() => closeFixture(f))

  it('candidate → active → deprecated：全程文件保留、状态流正确', async () => {
    const meta = await seedCandidate(f)
    await f.review.approve(meta.id)
    await f.knowledge.deprecate(meta.id)
    const after = await f.knowledge.getMeta(meta.id)
    expect(after?.status).toBe('deprecated')
    expect(existsSync(join(f.knowledge.rootDir, after!.path))).toBe(true)
  })

  it('candidate → active → superseded：合法；文件保留', async () => {
    const meta = await seedCandidate(f)
    await f.review.approve(meta.id)
    await f.review.supersede(meta.id, 'new-id-9', '生命周期')
    const after = await f.knowledge.getMeta(meta.id)
    expect(after?.status).toBe('superseded')
    expect(existsSync(join(f.knowledge.rootDir, after!.path))).toBe(true)
  })
})
