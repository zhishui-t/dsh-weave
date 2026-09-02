/**
 * T8 knowledge e2e: K1-K3
 *
 * K1 知识目录为空/未构建 → knowledge/graph 返回空图谱 + 可构建提示
 * K2 查询无匹配词 → knowledge/query 返回空文本，不崩溃
 * K3 有 candidate/active → 图谱渲染生命周期过滤仍生效
 */
import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KnowledgeGraphService } from '../dist/plugins/weave/graph/knowledge-graph.js'
import { KnowledgeStore } from '../dist/plugins/weave/knowledge-model.js'
import { WeavePersistence } from '../dist/plugins/weave/persistence/persistence.js'
import { WeaveQueryService } from '../dist/plugins/weave/web/query-service.js'

test.describe('T8 knowledge graph e2e (real Graphify + real KnowledgeStore)', () => {
  const roots: string[] = []
  const persists: WeavePersistence[] = []
  test.afterEach(() => {
    for (const p of persists.splice(0)) p.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), 'weave-e2e-kg-'))
    roots.push(root)
    const persistence = new WeavePersistence({ inMemory: true })
    persists.push(persistence)
    const store = new KnowledgeStore({
      rootDir: join(root, 'knowledge'),
      metaDb: persistence.knowledgeMeta,
    })
    const service = new KnowledgeGraphService({ store })
    const query = new WeaveQueryService({
      persistence,
      knowledgeStore: store,
      knowledgeGraphService: service,
    })
    return { root, store, service, query }
  }

  test('K1: 知识目录为空/未构建 → 空图谱 + 可构建提示', async () => {
    const { query, service } = makeEnv()
    expect(service.hasGraph()).toBe(false)

    const graph = (await query.dispatch('knowledge/graph', {})) as {
      nodes: unknown[]
      edges: unknown[]
      counts: { knowledge: number; missing: number; edges: number; unresolved: number; skipped: number }
    }
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
    expect(graph.counts).toMatchObject({ knowledge: 0, missing: 0, edges: 0 })
    // 轻量回退不要求已构建，未构建时不应抛错。
    expect(service.hasGraph()).toBe(false)
  })

  test('K2: 查询无匹配词 → 空文本，不崩溃', async () => {
    const { store, service, query } = makeEnv()
    await store.createCandidate({
      layer: 'project',
      scope: { projectId: 'demo', version: 'v1' },
      filename: 'a.md',
      frontmatter: { title: 'A 指南', type: 'doc', visibility: 'project_only', tags: [] },
      body: '内容 [[B 指南]]。',
    })
    await store.createCandidate({
      layer: 'project',
      scope: { projectId: 'demo', version: 'v1' },
      filename: 'b.md',
      frontmatter: { title: 'B 指南', type: 'doc', visibility: 'project_only', tags: [] },
      body: '内容 [[A 指南]]。',
    })
    await service.build()

    const result = (await query.dispatch('knowledge/query', { question: '不存在的词' })) as { text: string }
    expect(result.text).toBe('')
  })

  test('K3: candidate/active 过滤与图谱渲染仍可用', async () => {
    const { store, service, query } = makeEnv()
    const active = await store.createCandidate({
      layer: 'project',
      scope: { projectId: 'demo', version: 'v1' },
      filename: 'active.md',
      frontmatter: { title: '已激活知识', type: 'doc', visibility: 'project_only', tags: ['lifecycle'] },
      body: '正文 [[待审核知识]]。',
    })
    await store.activate(active.id, { confirmed: true })
    const pending = await store.createCandidate({
      layer: 'project',
      scope: { projectId: 'demo', version: 'v1' },
      filename: 'pending.md',
      frontmatter: { title: '待审核知识', type: 'doc', visibility: 'project_only', tags: ['lifecycle'] },
      body: '正文 [[已激活知识]]。',
    })

    await service.build()
    const all = (await query.dispatch('knowledge/graph', {})) as {
      nodes: Array<{ id: string; status: string }>
      counts: { knowledge: number }
    }
    expect(all.counts.knowledge).toBe(2)

    const activeOnly = (await query.dispatch('knowledge/graph', { status: 'active' })) as {
      nodes: Array<{ id: string; status: string }>
      counts: { knowledge: number }
    }
    expect(activeOnly.counts.knowledge).toBe(1)
    expect(activeOnly.nodes.map((node) => node.id)).toEqual([active.id])

    const candidateOnly = (await query.dispatch('knowledge/graph', { status: 'candidate' })) as {
      nodes: Array<{ id: string; status: string }>
      counts: { knowledge: number }
    }
    expect(candidateOnly.counts.knowledge).toBe(1)
    expect(candidateOnly.nodes.map((node) => node.id)).toEqual([pending.id])
  })
})
