/**
 * T8 negative e2e: C1-C3
 *
 * - C1 未构建 → code/graph configuration_error
 * - C2 已构建、查询不存在节点 → code/explain invalid_argument 或明确“未找到节点”
 * - C3 已构建、files=[] → code/affected [] 返回空结果，且不要求 flows.json
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, rmSync as removeFile } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GraphService } from '../dist/plugins/weave/graph/graph-service.js'
import { WeavePersistence } from '../dist/plugins/weave/persistence/persistence.js'
import { WeaveQueryService } from '../dist/plugins/weave/web/query-service.js'
import { WeaveError } from '../dist/plugins/weave/state/weave-error.js'

async function expectWeaveError(promise: Promise<unknown>, code: string): Promise<void> {
  let error: unknown
  try {
    await promise
  } catch (cause) {
    error = cause
  }
  expect(error, `expected WeaveError(${code})`).toBeInstanceOf(WeaveError)
  expect((error as WeaveError).code).toBe(code)
}

test.describe('T8 graph negative', () => {
  const roots: string[] = []
  test.afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  test('C1: 未构建 .graphify → code/graph configuration_error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-e2e-graph-neg-'))
    roots.push(root)
    const graphService = new GraphService({ projectRoot: root })
    expect(graphService.hasGraph()).toBe(false)
    const query = new WeaveQueryService({
      persistence: new WeavePersistence({ inMemory: true }),
      graphService,
    })
    await expectWeaveError(query.dispatch('code/graph', {}) as Promise<unknown>, 'configuration_error')
  })

  test('C2: 已构建、查询不存在节点 → 明确 invalid_argument / not-found（不抛内部错误）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-e2e-graph-neg-'))
    roots.push(root)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), `export function alpha(): number { return 1 }\n`, 'utf8')
    const graphService = new GraphService({ projectRoot: root })
    await graphService.build()

    const query = new WeaveQueryService({
      persistence: new WeavePersistence({ inMemory: true }),
      graphService,
    })
    let result: { text?: string } | undefined
    let error: unknown
    try {
      result = (await query.dispatch('code/explain', { node: 'definitely-not-exist' })) as { text?: string }
    } catch (cause) {
      error = cause
    }
    if (error) {
      // 抛出路径：允许 invalid_argument 或 graph_execution_failed，但不得内部崩溃
      expect(error).toBeInstanceOf(WeaveError)
      expect(['invalid_argument', 'graph_execution_failed']).toContain((error as WeaveError).code)
      return
    }
    // 返回路径：Graphify explain 对不存在节点返回明确 “No node matching”，属于 C2 允许的“明确未找到节点”
    expect(result?.text ?? '').toContain('No node matching')
  })

  test('C3: 已构建、files=[] → 返回空 affectedFlows，不要求 flows.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-e2e-graph-neg-'))
    roots.push(root)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), `export function alpha(): number { return 1 }\n`, 'utf8')
    const graphService = new GraphService({ projectRoot: root })
    await graphService.build()

    // 移除 flows.json，模拟“只有 graph.json、没有 flows.json”的场景
    removeFile(graphService.flowsPath)
    expect(graphService.hasFlows()).toBe(false)

    const query = new WeaveQueryService({
      persistence: new WeavePersistence({ inMemory: true }),
      graphService,
    })
    const result = (await query.dispatch('code/affected', { files: [] })) as {
      changedFiles: string[]
      matchedNodeIds: string[]
      unmatchedFiles: string[]
      affectedFlows: unknown[]
    }
    expect(result).toEqual({
      changedFiles: [],
      matchedNodeIds: [],
      unmatchedFiles: [],
      affectedFlows: [],
    })
  })
})
