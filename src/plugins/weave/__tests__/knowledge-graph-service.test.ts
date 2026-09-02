import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KnowledgeGraphService } from '../graph/knowledge-graph.js'
import { KnowledgeStore, type CreateCandidateInput } from '../knowledge/knowledge-model.js'
import { openPersistence } from '../persistence/index.js'
import { WeaveQueryService } from '../web/query-service.js'

const envs: Array<{ close: () => void }> = []

afterAll(() => {
  for (const env of envs) env.close()
})

async function newGraphService(): Promise<{ store: KnowledgeStore; service: KnowledgeGraphService }> {
  const rootDir = mkdtempSync(join(tmpdir(), 'weave-kgraph-service-'))
  const p = openPersistence({ inMemory: true })
  envs.push({
    close: () => {
      p.close()
      rmSync(rootDir, { recursive: true, force: true })
    },
  })
  const store = new KnowledgeStore({ rootDir: join(rootDir, 'knowledge'), metaDb: p.knowledgeMeta })
  return { store, service: new KnowledgeGraphService({ store }) }
}

async function seed(
  store: KnowledgeStore,
  overrides: Partial<CreateCandidateInput> & { title?: string; body?: string } = {},
) {
  return store.createCandidate({
    layer: 'project',
    scope: { projectId: 'demo', version: 'v1' },
    filename: `k-${Math.random().toString(36).slice(2, 10)}.md`,
    frontmatter: {
      title: overrides.title ?? '默认指南',
      type: 'doc',
      visibility: 'project_only',
      tags: overrides.frontmatter?.tags ?? [],
    },
    body: overrides.body ?? '# 默认正文',
    ...overrides,
  })
}

describe('KnowledgeGraphService Graphify 后端', () => {
  it('build 生成 graph.json，graph/query/path/explain 基于构建结果工作', async () => {
    const { store, service } = await newGraphService()
    const a = await seed(store, {
      filename: 'a.md',
      title: 'A 指南',
      body: '参见 [[B 指南]]。',
    })
    const b = await seed(store, {
      filename: 'b.md',
      title: 'B 指南',
      body: '反向引用 [[A 指南]]。',
    })

    expect(service.hasGraph()).toBe(false)
    const built = await service.build()
    expect(built.graphPath).toBe(service.graphPath)
    expect(built.nodeCount).toBe(2)
    expect(built.edgeCount).toBeGreaterThanOrEqual(1)
    expect(service.hasGraph()).toBe(true)

    const graph = await service.graph({})
    expect(graph.counts.knowledge).toBe(2)
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([a.id, b.id].sort())
    expect(
      graph.edges.some((edge) =>
        (edge.source === a.id && edge.target === b.id) ||
        (edge.source === b.id && edge.target === a.id),
      ),
    ).toBe(true)

    const text = await service.query('A 指南')
    expect(text).toContain('A 指南')

    const explained = await service.explain('A 指南')
    expect(explained).toContain('ID:')
    expect(explained).toContain('B 指南')

    const path = await service.path(a.id, b.id)
    expect(path).toContain('A 指南')
    expect(path).toContain('B 指南')
  })

  it('未构建时 graph 回退轻量 [[双链]] 预览；query/path/explain 报 configuration_error', async () => {
    const { store, service } = await newGraphService()
    const a = await seed(store, { title: '回退指南', body: '参见 [[缺失]]。' })
    expect(a.id).toBeTruthy()

    const fallback = await service.graph({})
    expect(fallback.counts).toMatchObject({ knowledge: 1, missing: 1 })
    expect(fallback.nodes.find((node) => node.kind === 'missing')).toMatchObject({ title: '缺失' })

    await expect(service.query('回退指南')).rejects.toMatchObject({ code: 'configuration_error' })
    await expect(service.path('x', 'y')).rejects.toMatchObject({ code: 'configuration_error' })
    await expect(service.explain('x')).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('query 无命中返回空文本；path/explain 未找到节点报 invalid_argument', async () => {
    const { store, service } = await newGraphService()
    await seed(store, { title: '唯一指南', body: '正文' })
    await service.build()

    const noHit = await service.query('不存在的词')
    expect(noHit).toBe('')

    await expect(service.path('不存在A', '不存在B')).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(service.explain('不存在')).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('status/layer 过滤在 Graphify 构建后仍生效', async () => {
    const { store, service } = await newGraphService()
    const activated = await seed(store, { title: '已激活知识', filename: 'activated.md' })
    await store.activate(activated.id, { confirmed: true })
    const pending = await seed(store, { title: '待审核知识', filename: 'pending.md' })

    await service.build()
    const activeOnly = await service.graph({ status: 'active' })
    expect(activeOnly.counts.knowledge).toBe(1)
    expect(activeOnly.nodes.map((node) => node.id)).toEqual([activated.id])

    const candidateOnly = await service.graph({ status: 'candidate' })
    expect(candidateOnly.counts.knowledge).toBe(1)
    expect(candidateOnly.nodes.map((node) => node.id)).toEqual([pending.id])
  })
})

describe('WeaveQueryService knowledge Graphify RPC 分发', () => {
  it('dispatch 路由 knowledge/build|query|path|explain；缺 question/source/target 报 invalid_argument', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'weave-kgraph-rpc-'))
    const p = openPersistence({ inMemory: true })
    const store = new KnowledgeStore({ rootDir: join(rootDir, 'knowledge'), metaDb: p.knowledgeMeta })
    const service = new KnowledgeGraphService({ store })
    const query = new WeaveQueryService({ persistence: p, knowledgeStore: store, knowledgeGraphService: service })
    envs.push({
      close: () => {
        p.close()
        rmSync(rootDir, { recursive: true, force: true })
      },
    })

    const a = await store.createCandidate({
      layer: 'project',
      scope: { projectId: 'demo', version: 'v1' },
      filename: 'rpc-a.md',
      frontmatter: { title: 'RPC A', type: 'doc', visibility: 'project_only', tags: ['rpc'] },
      body: '内容 [[RPC B]]',
    })
    const b = await store.createCandidate({
      layer: 'project',
      scope: { projectId: 'demo', version: 'v1' },
      filename: 'rpc-b.md',
      frontmatter: { title: 'RPC B', type: 'doc', visibility: 'project_only', tags: ['rpc'] },
      body: '内容 [[RPC A]]',
    })

    const built = (await query.dispatch('knowledge/build', {})) as { graphPath: string; nodeCount: number }
    expect(built.graphPath).toBe(service.graphPath)
    expect(built.nodeCount).toBeGreaterThanOrEqual(2)

    expect(((await query.dispatch('knowledge/query', { question: 'RPC A' })) as { text: string }).text).toContain('RPC A')
    expect(((await query.dispatch('knowledge/path', { source: a.id, target: b.id })) as { path: string }).path).toContain('RPC A')
    expect(((await query.dispatch('knowledge/explain', { node: a.id })) as { explain: string }).explain).toContain('RPC A')

    await expect(query.dispatch('knowledge/query', {})).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(query.dispatch('knowledge/path', { source: a.id })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(query.dispatch('knowledge/explain', {})).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('knowledgeGraphService 未注入时 build/query/path/explain 报 configuration_error', async () => {
    const p = openPersistence({ inMemory: true })
    const store = new KnowledgeStore({
      rootDir: join(mkdtempSync(join(tmpdir(), 'weave-kgraph-none-')), 'knowledge'),
      metaDb: p.knowledgeMeta,
    })
    const query = new WeaveQueryService({ persistence: p, knowledgeStore: store })
    try {
      await expect(query.knowledgeBuild({})).rejects.toMatchObject({ code: 'configuration_error' })
      await expect(query.knowledgeQuery({ question: 'x' })).rejects.toMatchObject({ code: 'configuration_error' })
      await expect(query.knowledgePath({ source: 'a', target: 'b' })).rejects.toMatchObject({ code: 'configuration_error' })
      await expect(query.knowledgeExplain({ node: 'a' })).rejects.toMatchObject({ code: 'configuration_error' })
    } finally {
      p.close()
    }
  })
})
