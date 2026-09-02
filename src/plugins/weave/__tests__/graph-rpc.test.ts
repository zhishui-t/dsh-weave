import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { GraphService, type AffectedFlowsResult, type GraphFlow, type GraphSummary } from '../graph/graph-service'
import { WeavePersistence } from '../persistence/persistence'
import { WeaveQueryService } from '../web/query-service'
import { createWeaveRpcHandler } from '../host/rpc'
import { WeaveError } from '../state/weave-error'

const sampleFlow = (id: string): GraphFlow => ({
  id,
  name: `Flow ${id}`,
  entryPoint: `src/${id}.ts`,
  entryPointId: id,
  path: [id],
  qualifiedPath: [`src/${id}.ts`],
  depth: 1,
  nodeCount: 2,
  fileCount: 2,
  files: [`src/${id}.ts`, `src/${id}-dep.ts`],
  criticality: 1,
  warnings: [],
})

const sampleSummary: GraphSummary = {
  graphPath: '/repo/.graphify/graph.json',
  flowsPath: '/repo/.graphify/flows.json',
  nodeCount: 3,
  edgeCount: 4,
  communityCount: 2,
  builtFromCommit: 'abc123',
  hasFlows: true,
}

interface FakeGraphOverrides {
  hasGraph?: () => boolean
  hasFlows?: () => boolean
}

function makeFakeGraph(overrides: FakeGraphOverrides = {}): GraphService {
  return {
    projectRoot: '/repo',
    graphPath: '/repo/.graphify/graph.json',
    flowsPath: '/repo/.graphify/flows.json',
    hasGraph: overrides.hasGraph ?? (() => true),
    hasFlows: overrides.hasFlows ?? (() => true),
    graphSummary: async () => sampleSummary,
    path: async (source: string, target: string) => `path ${source} -> ${target}`,
    explain: async (node: string) => `explain ${node}`,
    affectedFlows: async (files: string[]): Promise<AffectedFlowsResult> => ({
      changedFiles: files,
      matchedNodeIds: [],
      unmatchedFiles: [],
      affectedFlows: [],
    }),
    listFlows: async (limit = 50) => [sampleFlow('f1'), sampleFlow('f2')].slice(0, limit),
    getFlow: async (id: string) => sampleFlow(id),
  } as unknown as GraphService
}

function makeQueryService(graphService: GraphService = makeFakeGraph()): WeaveQueryService {
  return new WeaveQueryService({
    persistence: new WeavePersistence({ inMemory: true }),
    graphService,
  })
}

async function expectWeaveError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    expect.unreachable(`expected WeaveError(${code})`)
  } catch (error) {
    expect(error).toBeInstanceOf(WeaveError)
    expect((error as WeaveError).code).toBe(code)
  }
}

describe('WeaveQueryService code/* RPC', () => {
  it('code/graph 返回图谱摘要', async () => {
    const query = makeQueryService()
    await expect(query.codeGraph({})).resolves.toMatchObject(sampleSummary)
  })

  it('code/graph 未注入 graphService 或图谱未构建时 configuration_error', async () => {
    const noService = new WeaveQueryService({ persistence: new WeavePersistence({ inMemory: true }) })
    await expectWeaveError(noService.codeGraph({}), 'configuration_error')

    const missing = makeQueryService(makeFakeGraph({ hasGraph: () => false }))
    await expectWeaveError(missing.codeGraph({}), 'configuration_error')
  })

  it('code/path 返回路径文本；缺参与未构建均报错', async () => {
    const query = makeQueryService()
    await expect(query.codePath({ source: 'a', target: 'b' })).resolves.toEqual({
      source: 'a',
      target: 'b',
      path: 'path a -> b',
      text: 'path a -> b',
    })
    await expectWeaveError(query.codePath({ target: 'b' }), 'invalid_argument')
    await expectWeaveError(query.codePath({ source: 'a' }), 'invalid_argument')

    const missing = makeQueryService(makeFakeGraph({ hasGraph: () => false }))
    await expectWeaveError(missing.codePath({ source: 'a', target: 'b' }), 'configuration_error')
  })

  it('code/explain 返回解释文本；缺 node 报 invalid_argument', async () => {
    const query = makeQueryService()
    await expect(query.codeExplain({ node: 'a' })).resolves.toEqual({ node: 'a', explain: 'explain a', text: 'explain a' })
    await expectWeaveError(query.codeExplain({}), 'invalid_argument')
  })

  it('code/affected 校验 files 数组；空数组直接返回空结果', async () => {
    const query = makeQueryService()
    await expect(query.codeAffected({ files: ['src/a.ts', 'src/b.ts'] })).resolves.toMatchObject({
      changedFiles: ['src/a.ts', 'src/b.ts'],
      affectedFlows: [],
    })
    await expect(query.codeAffected({ files: [] })).resolves.toMatchObject({
      changedFiles: [],
      affectedFlows: [],
    })
    await expectWeaveError(query.codeAffected({}), 'invalid_argument')
    await expectWeaveError(query.codeAffected({ files: [1] }), 'invalid_argument')
    await expectWeaveError(query.codeAffected({ files: [''] }), 'invalid_argument')
  })

  it('code/flows 返回执行流列表；limit 非法报 invalid_argument', async () => {
    const query = makeQueryService()
    await expect(query.codeFlows({})).resolves.toMatchObject({
      flows: expect.arrayContaining([expect.objectContaining({ id: 'f1' })]),
    })
    await expect(query.codeFlows({ limit: 1 })).resolves.toMatchObject({ flows: [expect.objectContaining({ id: 'f1' })] })
    await expectWeaveError(query.codeFlows({ limit: 0 }), 'invalid_argument')
    await expectWeaveError(query.codeFlows({ limit: -1 }), 'invalid_argument')
  })

  it('code/flows/get 返回执行流详情；缺 id 报 invalid_argument', async () => {
    const query = makeQueryService()
    await expect(query.codeFlowGet({ id: 'flow-x' })).resolves.toMatchObject({ id: 'flow-x' })
    await expectWeaveError(query.codeFlowGet({}), 'invalid_argument')
  })

  it('code/affected 与 code/flows 在 flows.json 缺失时报 configuration_error', async () => {
    const query = makeQueryService(makeFakeGraph({ hasFlows: () => false }))
    await expectWeaveError(query.codeAffected({ files: ['src/a.ts'] }), 'configuration_error')
    await expectWeaveError(query.codeFlows({}), 'configuration_error')
    await expectWeaveError(query.codeFlowGet({ id: 'x' }), 'configuration_error')
  })
})

describe('Weave RPC 通道透传 code/*', () => {
  it('code/flows 经 createWeaveRpcHandler 路由到 queryService 并返回信封', async () => {
    const query = makeQueryService()
    const call = createWeaveRpcHandler({ queryService: query } as never)
    const result = await call('code/flows', { limit: 1 })
    expect(result).toMatchObject({
      ok: true,
      value: { flows: [expect.objectContaining({ id: 'f1' })] },
    })
    const missing = await call('code/path', {})
    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'bad-request', details: { original_code: 'invalid_argument' } },
    })
  })
})

describe('GraphService.graphSummary', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('读取 graph.json 返回节点/边/社区数与提交信息', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-graph-summary-'))
    roots.push(root)
    const graphDir = join(root, '.graphify')
    mkdirSync(graphDir, { recursive: true })
    writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({
      nodes: [
        { id: 'a', community: 0 },
        { id: 'b', community: 0 },
        { id: 'c', community: 1 },
      ],
      links: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
      graph: { community_labels: { 0: 'C0', 1: 'C1' }, built_from_commit: 'deadbeef' },
    }))
    writeFileSync(join(graphDir, 'flows.json'), JSON.stringify({ flows: [] }))

    const service = new GraphService({ projectRoot: root, cliPath: join(root, 'no-cli.js') })
    await expect(service.graphSummary()).resolves.toMatchObject({
      nodeCount: 3,
      edgeCount: 2,
      communityCount: 2,
      builtFromCommit: 'deadbeef',
      hasFlows: true,
    })
  })

  it('graph.json 缺失时报 configuration_error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-graph-missing-'))
    roots.push(root)
    const service = new GraphService({ projectRoot: root, cliPath: join(root, 'no-cli.js') })
    await expectWeaveError(service.graphSummary(), 'configuration_error')
  })

  it('默认 CLI 路径解析可构造（不依赖 package.json 子路径导出）', () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-graph-cli-'))
    roots.push(root)
    const service = new GraphService({ projectRoot: root })
    expect(service.hasGraph()).toBe(false)
  })
})
