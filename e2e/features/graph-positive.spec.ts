/**
 * T8 positive e2e: code:scan → code/graph → code/path → code/explain → code/affected
 *
 * 真实 Graphify CLI + 临时项目目录，不 mock 成功路径。
 * 运行前提：pnpm build（dist 与 src 同步）。
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GraphService } from '../../dist/plugins/weave/graph/graph-service.js'
import { WeavePersistence } from '../../dist/plugins/weave/persistence/persistence.js'
import { WeaveQueryService } from '../../dist/plugins/weave/web/query-service.js'

test.describe('T8 graph positive (real Graphify CLI)', () => {
  const roots: string[] = []
  test.afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  test('code:scan → code/graph → code/path → code/explain → code/affected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-e2e-graph-pos-'))
    roots.push(root)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'a.ts'),
      `export function alpha(): number { return 1 }\nexport function beta() { return alpha() }\n`,
      'utf8',
    )
    writeFileSync(
      join(root, 'src', 'b.ts'),
      `export function gamma(): number { return 2 }\n`,
      'utf8',
    )

    // code:scan（GraphService.build = graphify extract + flows build）
    const graphService = new GraphService({ projectRoot: root })
    const built = await graphService.build()
    expect(built.graphPath).toBe(graphService.graphPath)
    expect(built.flowsPath).toBe(graphService.flowsPath)
    expect(graphService.hasGraph()).toBe(true)
    expect(graphService.hasFlows()).toBe(true)

    const query = new WeaveQueryService({
      persistence: new WeavePersistence({ inMemory: true }),
      graphService,
    })

    // code/graph：真实 graph.json 摘要
    const summary = (await query.dispatch('code/graph', {})) as {
      nodeCount: number
      edgeCount: number
      hasFlows: boolean
    }
    expect(summary.nodeCount).toBeGreaterThanOrEqual(3)
    expect(summary.edgeCount).toBeGreaterThanOrEqual(3)
    expect(summary.hasFlows).toBe(true)

    // code/path：两个函数节点之间的真实最短路径（Graphify CLI 使用 label 如 alpha/beta）
    const pathResult = (await query.dispatch('code/path', { source: 'alpha', target: 'beta' })) as {
      source: string
      target: string
      path: string
      text: string
    }
    expect(pathResult.source).toBe('alpha')
    expect(pathResult.target).toBe('beta')
    expect(pathResult.text).toContain('alpha')
    expect(pathResult.text).toContain('beta')

    // code/explain：真实节点解释（label alpha → node id a_alpha）
    const explainResult = (await query.dispatch('code/explain', { node: 'alpha' })) as { explain: string; text: string }
    expect(explainResult.explain).toContain('Node:')
    expect(explainResult.text).toContain('alpha')

    // code/affected：真实文件影响面（build 后 flows.json 必须可用）
    const affected = (await query.dispatch('code/affected', { files: ['src/a.ts'] })) as {
      changedFiles: string[]
      affectedFlows: Array<{ id: string }>
    }
    expect(affected.changedFiles).toEqual(['src/a.ts'])
    expect(Array.isArray(affected.affectedFlows)).toBe(true)

    // 补充：code/flows 也走真实 JSON（正向前置）
    const flows = (await query.dispatch('code/flows', { limit: 10 })) as { flows: unknown[] }
    expect(flows.flows.length).toBeGreaterThan(0)
  })
})
