/**
 * buildKnowledgeGraph 纯函数测试 —— project 按项目过滤。
 *
 * 覆盖：命中（_agent/projects/{projectId}/ 前缀匹配）、未命中（空图）、
 * 非项目区（role/shared）排除、includeLinkedLayers 跨层引用边保留、
 * limit 在 project 过滤之后生效、projects 去重清单、空 project 入参报错。
 *
 * 运行：pnpm vitest run src/plugins/weave/__tests__/knowledge-graph.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KnowledgeStore, type CreateCandidateInput } from '../knowledge/knowledge-model.js'
import { openPersistence } from '../persistence/index.js'
import { WeaveError } from '../state/weave-error.js'
import { buildKnowledgeGraph } from '../web/knowledge-graph.js'

const envs: Array<{ close: () => void }> = []

afterAll(() => {
  for (const env of envs) env.close()
})

async function newStore(): Promise<KnowledgeStore> {
  const rootDir = mkdtempSync(join(tmpdir(), 'weave-kgraph-'))
  const p = openPersistence({ inMemory: true })
  envs.push({ close: () => {
    p.close()
    rmSync(rootDir, { recursive: true, force: true })
  } })
  return new KnowledgeStore({ rootDir: join(rootDir, 'knowledge'), metaDb: p.knowledgeMeta })
}

async function seed(store: KnowledgeStore, overrides: Partial<CreateCandidateInput> = {}) {
  return store.createCandidate({
    layer: 'project',
    scope: { projectId: 'demo', version: 'v1' },
    filename: `k-${Math.random().toString(36).slice(2, 10)}.md`,
    frontmatter: { title: '项目指南', type: 'doc', visibility: 'project_only', tags: [] },
    body: '# 正文',
    ...overrides,
  })
}

describe('buildKnowledgeGraph project 过滤', () => {
  it('命中：只保留 _agent/projects/{project}/ 前缀条目，projects 清单全量去重', async () => {
    const store = await newStore()
    const demo = await seed(store, { frontmatter: { title: 'Demo 指南', type: 'doc', visibility: 'project_only', tags: [] } })
    await seed(store, {
      scope: { projectId: 'other', version: 'v1' },
      filename: 'other.md',
      frontmatter: { title: 'Other 指南', type: 'doc', visibility: 'project_only', tags: [] },
    })
    await seed(store, {
      layer: 'role',
      scope: { roleId: 'designer' },
      filename: 'role.md',
      frontmatter: { title: '角色规范', type: 'guide', visibility: 'role_only', tags: [] },
    })
    await seed(store, {
      layer: 'shared',
      scope: {},
      filename: 'shared.md',
      frontmatter: { title: '共享经验', type: 'pitfall', visibility: 'global', tags: [] },
    })

    const graph = await buildKnowledgeGraph(store, { project: 'demo' })
    const knowledge = graph.nodes.filter((node) => node.kind === 'knowledge')
    expect(knowledge).toHaveLength(1)
    expect(knowledge[0]).toMatchObject({ id: demo.id, path: `_agent/projects/demo/v1/${(demo.path.split('/').at(-1) ?? '')}` })
    expect(graph.counts).toMatchObject({ knowledge: 1, skipped: 0 })
    // projects 清单来自全量 listMeta 去重，不受 project/status/layer 过滤影响
    expect(graph.projects).toEqual(['demo', 'other'])

    const unfiltered = await buildKnowledgeGraph(store, {})
    expect(unfiltered.counts.knowledge).toBe(4)
    expect(unfiltered.projects).toEqual(['demo', 'other'])
  })

  it('未命中：不存在的项目返回零知识节点', async () => {
    const store = await newStore()
    await seed(store)

    const graph = await buildKnowledgeGraph(store, { project: 'ghost' })
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
    expect(graph.counts).toMatchObject({ knowledge: 0, edges: 0, missing: 0, unresolved: 0, skipped: 0 })
  })

  it('跨层边保留：includeLinkedLayers 时项目内条目引用共享层条目解析为 linked 节点', async () => {
    const store = await newStore()
    const shared = await seed(store, {
      layer: 'shared',
      scope: {},
      filename: 'shared-link.md',
      frontmatter: { title: '协作六律', type: 'pattern', visibility: 'global', tags: [] },
    })
    const demo = await seed(store, { frontmatter: { title: 'Demo 指南', type: 'doc', visibility: 'project_only', tags: [] }, body: '参见 [[协作六律]]。' })

    // 无 includeLinkedLayers：项目过滤后共享层不在解析集，双链降级为 missing
    const strict = await buildKnowledgeGraph(store, { project: 'demo' })
    expect(strict.nodes.find((node) => node.id === `missing:协作六律`)).toMatchObject({ kind: 'missing' })
    expect(strict.edges).toEqual([{ source: demo.id, target: 'missing:协作六律' }])

    // includeLinkedLayers：跨层引用边保留，目标节点标记 linked
    const linked = await buildKnowledgeGraph(store, { project: 'demo', includeLinkedLayers: true })
    expect(linked.nodes.find((node) => node.id === shared.id)).toMatchObject({ kind: 'knowledge', linked: true, layer: 'shared' })
    expect(linked.edges).toContainEqual({ source: demo.id, target: shared.id })
    expect(linked.counts).toMatchObject({ knowledge: 1, missing: 0 })
  })

  it('limit 在 project 过滤之后生效', async () => {
    const store = await newStore()
    for (let index = 0; index < 3; index += 1) {
      await seed(store, {
        scope: { projectId: 'bulk', version: 'v1' },
        filename: `bulk-${index}.md`,
        frontmatter: { title: `批量 ${index}`, type: 'doc', visibility: 'project_only', tags: [] },
      })
    }
    await seed(store, { frontmatter: { title: 'Demo 指南', type: 'doc', visibility: 'project_only', tags: [] } })

    const graph = await buildKnowledgeGraph(store, { project: 'bulk', limit: 2 })
    expect(graph.nodes.filter((node) => node.kind === 'knowledge')).toHaveLength(2)
    expect(graph.counts.knowledge).toBe(2)
  })

  it('空 project 报 invalid_argument；undefined 视为不过滤', async () => {
    const store = await newStore()
    await seed(store)
    try {
      await buildKnowledgeGraph(store, { project: '  ' })
      expect.unreachable('应抛出 WeaveError')
    } catch (error) {
      expect(error).toBeInstanceOf(WeaveError)
      expect((error as WeaveError).code).toBe('invalid_argument')
    }
    expect((await buildKnowledgeGraph(store, { project: undefined })).counts.knowledge).toBe(1)
  })
})
