import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPersistence, type WeavePersistence } from '../persistence/index.js'
import {
  agentLayerDir,
  KnowledgeStore,
  parseFrontmatter,
  serializeKnowledgeFile,
  validateFrontmatter,
  validateVisibility,
  type KnowledgeFrontmatter,
} from '../knowledge/knowledge-model.js'

/** 合法 frontmatter（9 个必填字段）。 */
const fm = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  schema_version: '1',
  title: 'gRPC 级联超时踩坑记录',
  type: 'pitfall',
  status: 'candidate',
  confidence: 0.1,
  created: '2026-08-24',
  freshness_score: 1.0,
  visibility: 'project_only',
  tags: ['gRPC', '超时'],
  ...overrides,
})

const baseInput = {
  layer: 'project' as const,
  scope: { projectId: 'demo', version: 'v1' },
  filename: 'grpc-fallback.md',
  frontmatter: { title: 'gRPC 级联超时踩坑记录', type: 'pitfall' as const, visibility: 'project_only' as const, tags: ['gRPC', '超时'] },
  body: '正文内容...',
}

describe('agentLayerDir：四层知识目录（AC-KNOW-001）', () => {
  it('project → _agent/projects/{projectId}/{version}', () => {
    expect(agentLayerDir('project', { projectId: 'demo', version: 'v1' })).toBe('_agent/projects/demo/v1')
  })

  it('role → _agent/roles/{roleId}', () => {
    expect(agentLayerDir('role', { roleId: 'designer' })).toBe('_agent/roles/designer')
  })

  it('instance → _agent/instances/{instanceId}', () => {
    expect(agentLayerDir('instance', { instanceId: 'inst-01' })).toBe('_agent/instances/inst-01')
  })

  it('shared → _agent/shared', () => {
    expect(agentLayerDir('shared', {})).toBe('_agent/shared')
  })

  it('缺少归属字段时抛错（project 缺 version）', () => {
    expect(() => agentLayerDir('project', { projectId: 'demo' })).toThrow(/version/)
  })

  it('归属字段含路径穿越（.. / 分隔符）时抛错', () => {
    expect(() => agentLayerDir('project', { projectId: '..', version: 'v1' })).toThrow(/project_id/)
    expect(() => agentLayerDir('role', { roleId: 'a/b' })).toThrow(/role_id/)
  })
})

describe('validateVisibility：层与可见性匹配', () => {
  it('匹配时无错误；不匹配时报错并给期望值', () => {
    expect(validateVisibility('project', 'project_only')).toEqual([])
    expect(validateVisibility('role', 'role_only')).toEqual([])
    expect(validateVisibility('instance', 'instance_only')).toEqual([])
    expect(validateVisibility('shared', 'global')).toEqual([])

    expect(validateVisibility('project', 'global')).toHaveLength(1)
    expect(validateVisibility('shared', 'project_only')).toHaveLength(1)
  })
})

describe('validateFrontmatter：规范校验（AC-KNOW-002）', () => {
  it('合法 frontmatter 通过并返回强类型值', () => {
    const result = validateFrontmatter(fm())
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      schema_version: '1',
      title: 'gRPC 级联超时踩坑记录',
      type: 'pitfall',
      status: 'candidate',
      confidence: 0.1,
      created: '2026-08-24',
      freshness_score: 1.0,
      visibility: 'project_only',
      tags: ['gRPC', '超时'],
    })
  })

  it("schema_version 缺失或非 \"1\" 时失败（强制）", () => {
    expect(validateFrontmatter(fm({ schema_version: undefined })).ok).toBe(false)
    expect(validateFrontmatter(fm({ schema_version: '2' })).ok).toBe(false)
    expect(validateFrontmatter(fm({ schema_version: 1 })).ok).toBe(true) // 数字 1 兼容为 "1"
  })

  it('缺失/非法 title、type、status、visibility', () => {
    expect(validateFrontmatter(fm({ title: '' })).ok).toBe(false)
    expect(validateFrontmatter(fm({ title: undefined })).ok).toBe(false)
    expect(validateFrontmatter(fm({ type: 'unknown' })).ok).toBe(false)
    expect(validateFrontmatter(fm({ status: 'confirmed' })).ok).toBe(false)
    expect(validateFrontmatter(fm({ visibility: 'team_only' })).ok).toBe(false)
  })

  it('confidence/freshness_score 越界或非数值时失败', () => {
    expect(validateFrontmatter(fm({ confidence: -0.1 })).ok).toBe(false)
    expect(validateFrontmatter(fm({ confidence: 1.2 })).ok).toBe(false)
    expect(validateFrontmatter(fm({ confidence: '0.1' })).ok).toBe(false)
    expect(validateFrontmatter(fm({ freshness_score: 2 })).ok).toBe(false)
    expect(validateFrontmatter(fm({ freshness_score: 0 })).ok).toBe(true)
  })

  it('created 必须为 YYYY-MM-DD；tags 必须为 string[]', () => {
    expect(validateFrontmatter(fm({ created: '2026/08/24' })).ok).toBe(false)
    expect(validateFrontmatter(fm({ created: '2026-08-24T00:00:00Z' })).ok).toBe(false)
    expect(validateFrontmatter(fm({ tags: 'gRPC' })).ok).toBe(false)
    expect(validateFrontmatter(fm({ tags: [1, 2] })).ok).toBe(false)
    expect(validateFrontmatter(fm({ tags: [] })).ok).toBe(true)
  })

  it('错误信息可读（逐条列出）', () => {
    const result = validateFrontmatter(fm({ schema_version: '2', title: '' }))
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBe(2)
    expect(result.errors.join('\n')).toContain("'schema_version'")
    expect(result.errors.join('\n')).toContain("'title'")
  })
})

describe('frontmatter 解析/序列化', () => {
  it('serialize → parse 往返一致', () => {
    const original: KnowledgeFrontmatter = {
      schema_version: '1',
      title: 'gRPC 级联超时踩坑记录',
      type: 'pitfall',
      status: 'active',
      confidence: 0.7,
      created: '2026-08-24',
      freshness_score: 0.9,
      visibility: 'project_only',
      tags: ['gRPC', '超时'],
    }
    const text = serializeKnowledgeFile(original, '正文...\n')
    const parsed = parseFrontmatter(text)
    expect(parsed.frontmatter).not.toBeNull()
    const validated = validateFrontmatter(parsed.frontmatter!)
    expect(validated.ok).toBe(true)
    expect(validated.value).toEqual(original)
    expect(parsed.body.trim()).toBe('正文...')
  })

  it('无 frontmatter 块时返回 null 与原文', () => {
    const parsed = parseFrontmatter('# 纯 Markdown\n内容')
    expect(parsed.frontmatter).toBeNull()
    expect(parsed.body).toBe('# 纯 Markdown\n内容')
  })
})

describe('KnowledgeStore：目录隔离与写入规则', () => {
  let root: string
  let p: WeavePersistence

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-kb-'))
    p = openPersistence({ inMemory: true })
  })

  afterAll(() => {
    p.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('初始化创建三目录隔离（_agent/_human/_views）', () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    expect(existsSync(store.agentRoot())).toBe(true)
    expect(existsSync(store.humanRoot())).toBe(true)
    expect(existsSync(store.viewsRoot())).toBe(true)
    expect(existsSync(join(store.agentRoot(), 'projects'))).toBe(true)
    expect(existsSync(join(store.agentRoot(), 'roles'))).toBe(true)
    expect(existsSync(join(store.agentRoot(), 'instances'))).toBe(true)
    expect(existsSync(join(store.agentRoot(), 'shared'))).toBe(true)
  })

  it('createCandidate 写入 _agent 区（不写 _human/_views），返回元数据', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    const meta = await store.createCandidate(baseInput)

    expect(meta.status).toBe('candidate')
    expect(meta.layer).toBe('project')
    expect(meta.path.startsWith('_agent/projects/demo/v1/')).toBe(true)
    expect(meta.path.endsWith('grpc-fallback.md')).toBe(true)
    expect(meta.path.startsWith('_human/')).toBe(false)
    expect(meta.path.startsWith('_views/')).toBe(false)
    expect(existsSync(join(root, meta.path))).toBe(true)
  })

  it('未确认前不写 active：createCandidate 强制 status=candidate（即使期望 active）', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    const meta = await store.createCandidate({ ...baseInput, filename: 'active-attempt.md' })

    const raw = store.readRaw(meta.id)
    expect(raw).toContain('status: candidate')
    expect(raw).not.toContain('status: active')
    // 强制默认值：schema_version="1"、confidence=0.1、freshness=1.0
    expect(raw).toContain('schema_version: "1"')
    expect(raw).toContain('confidence: 0.1')
    expect(raw).toContain('freshness_score: 1')
    expect(raw).toMatch(/^created: \d{4}-\d{2}-\d{2}$/m)
  })

  it('createCandidate 的层与 visibility 不匹配时抛错', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    await expect(
      store.createCandidate({ ...baseInput, layer: 'shared', filename: 'bad-vis.md' }),
    ).rejects.toThrow(/visibility/)
  })

  it('文件名安全：路径穿越 / 分隔符 / 非 .md 均拒绝', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    await expect(store.createCandidate({ ...baseInput, filename: '../evil.md' })).rejects.toThrow(/filename/)
    await expect(store.createCandidate({ ...baseInput, filename: 'a/b.md' })).rejects.toThrow(/filename/)
    await expect(store.createCandidate({ ...baseInput, filename: 'notes.txt' })).rejects.toThrow(/\.md/)
  })

  it('getKnowledgeFile 与元数据一致（状态与 frontmatter 同步）', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    const meta = await store.createCandidate(baseInput)
    const file = store.getKnowledgeFile(meta.id)
    expect(file?.frontmatter.status).toBe('candidate')
    expect(file?.frontmatter.schema_version).toBe('1')
    expect(file?.body).toContain('正文内容')
  })
})

describe('KnowledgeStore：生命周期（AC-KNOW-003）', () => {
  let root: string
  let p: WeavePersistence

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-kb-life-'))
    p = openPersistence({ inMemory: true })
  })

  afterAll(() => {
    p.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('未确认不得转正：activate 无 confirmed 抛错，文件与元数据仍为 candidate', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    const meta = await store.createCandidate(baseInput)

    await expect(store.activate(meta.id, { confirmed: false })).rejects.toThrow(/确认/)
    const after = await store.getMeta(meta.id)
    expect(after?.status).toBe('candidate')
    expect(store.readRaw(meta.id)).toContain('status: candidate')
  })

  it('activate(confirmed: true)：candidate → active，last_confirmed 写入，文件同步', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    const meta = await store.createCandidate(baseInput)

    const active = await store.activate(meta.id, { confirmed: true })
    expect(active.status).toBe('active')
    expect(active.last_confirmed).not.toBeNull()
    expect(store.readRaw(meta.id)).toContain('status: active')
  })

  it('reject：candidate → deprecated（FDD 4.6.3）', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    const meta = await store.createCandidate(baseInput)
    const rejected = await store.reject(meta.id)
    expect(rejected.status).toBe('deprecated')
    expect(store.readRaw(meta.id)).toContain('status: deprecated')
  })

  it('deprecate：active → deprecated', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    const meta = await store.createCandidate(baseInput)
    await store.activate(meta.id, { confirmed: true })
    const deprecated = await store.deprecate(meta.id)
    expect(deprecated.status).toBe('deprecated')
  })

  it('supersede：active → superseded（superseded_by 仅在返回对象中）', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    const meta = await store.createCandidate(baseInput)
    await store.activate(meta.id, { confirmed: true })
    const superseded = await store.supersede(meta.id, 'new-id-001')
    expect(superseded.status).toBe('superseded')
    expect(superseded.superseded_by).toBe('new-id-001')
    expect(store.readRaw(meta.id)).toContain('status: superseded')
  })

  it('非法转移全部拒绝：activate 两次、candidate→superseded、deprecated→active', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    const a = await store.createCandidate({ ...baseInput, filename: 'illegal-a.md' })
    await store.activate(a.id, { confirmed: true })
    await expect(store.activate(a.id, { confirmed: true })).rejects.toThrow(/非法状态转移/)

    const b = await store.createCandidate({ ...baseInput, filename: 'illegal-b.md' })
    await expect(store.supersede(b.id, 'x')).rejects.toThrow(/非法状态转移/)

    const c = await store.createCandidate({ ...baseInput, filename: 'illegal-c.md' })
    await store.reject(c.id)
    await expect(store.activate(c.id, { confirmed: true })).rejects.toThrow(/非法状态转移/)
  })

  it('getMeta / listMeta：按 layer/status 过滤', async () => {
    const store = new KnowledgeStore({ rootDir: root, metaDb: p.knowledgeMeta })
    const roleMeta = await store.createCandidate({
      ...baseInput,
      layer: 'role',
      scope: { roleId: 'designer' },
      filename: 'role-note.md',
      frontmatter: { ...baseInput.frontmatter, visibility: 'role_only' },
    })
    const allRole = await store.listMeta({ layer: 'role' })
    expect(allRole.map((m) => m.id)).toContain(roleMeta.id)
    // layer+status 组合过滤：role 层 candidate 只此一条
    const roleCandidates = await store.listMeta({ layer: 'role', status: 'candidate' })
    expect(roleCandidates.map((m) => m.id)).toEqual([roleMeta.id])
    expect(await store.getMeta('no-such-id')).toBeNull()
  })
})

describe('KnowledgeStore：元数据持久化（knowledge_meta.db）', () => {
  let root: string
  let dir: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-kb-persist-root-'))
    dir = mkdtempSync(join(tmpdir(), 'weave-kb-persist-state-'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it('关闭重开（文件库）：元数据与文件仍在，状态可继续转移', async () => {
    const p1 = openPersistence({ stateDir: dir })
    const store1 = new KnowledgeStore({ rootDir: root, metaDb: p1.knowledgeMeta })
    const meta = await store1.createCandidate(baseInput)
    await store1.activate(meta.id, { confirmed: true })
    p1.close()

    const p2 = openPersistence({ stateDir: dir })
    const store2 = new KnowledgeStore({ rootDir: root, metaDb: p2.knowledgeMeta })
    try {
      const restored = await store2.getMeta(meta.id)
      expect(restored?.status).toBe('active')
      expect(restored?.path).toBe(meta.path)
      expect(existsSync(join(root, restored!.path))).toBe(true)

      const deprecated = await store2.deprecate(meta.id)
      expect(deprecated.status).toBe('deprecated')
    } finally {
      p2.close()
    }
  })
})
