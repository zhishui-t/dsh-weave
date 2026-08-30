// ③ DAG 图（对齐后的紧凑实现）：节点 92×30 固定几何、列=依赖深度、行=id 稳定排序、
// 贝塞尔边锚定节点盒中线、聚焦上下游链（data-active/data-dimmed）、画布=内容尺寸 + 横向滚动。
import { expect, test } from '@playwright/test'

import { HARNESS_DESCRIBE, loadHarnessAssets, mountSessionPanel, openHarnessPage } from '../harness/fixtures'

test.beforeAll(loadHarnessAssets)

/** 菱形 DAG：A→(B,C)→D，覆盖分支/汇合/同级排序。 */
const DIAMOND_DAG = {
  dag_id: 'D1',
  status: 'running',
  tasks: [
    { id: 'T-A', description: '根任务', status: 'RUNNING', dependencies: [], assigned_agent: 'coder' },
    { id: 'T-B', description: '分支B', status: 'WAITING', dependencies: ['T-A'], assigned_agent: 'coder' },
    { id: 'T-C', description: '分支C', status: 'COMPLETED', dependencies: ['T-A'], assigned_agent: 'reviewer' },
    { id: 'T-D', description: '汇合D', status: 'WAITING', dependencies: ['T-B', 'T-C'], assigned_agent: 'reviewer' },
  ],
  edges: [
    { from: 'T-A', to: 'T-B' },
    { from: 'T-A', to: 'T-C' },
    { from: 'T-B', to: 'T-D' },
    { from: 'T-C', to: 'T-D' },
  ],
}

/** 链式 DAG 场景（可选显式 edges）。 */
function chainScenario(n: number, withEdges: boolean) {
  const ids = Array.from({ length: n }, (_, i) => `N-${String(i).padStart(2, '0')}`)
  return {
    dag_id: 'D1',
    status: 'running',
    tasks: ids.map((id, i) => ({
      id,
      description: `链式任务 ${i}`,
      status: i === 1 ? 'RUNNING' : i < n - 1 ? 'WAITING' : 'COMPLETED',
      dependencies: i === 0 ? [] : [ids[i - 1]!],
    })),
    edges: withEdges ? ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id })) : [],
  }
}

async function openDagPage(page: import('@playwright/test').Page, taskGet?: unknown): Promise<void> {
  await openHarnessPage(page, taskGet ? { 'task/get': { ok: true, value: taskGet } } : undefined)
  await mountSessionPanel(page)
  await expect(page.getByTestId('dag-panel')).toBeVisible()
}

test.describe(HARNESS_DESCRIBE, () => {
  test('nodes: 节点数量、短 ID、状态标签、执行者文案齐全', async ({ page }) => {
    await openDagPage(page, DIAMOND_DAG)
    await expect(page.locator('[data-testid^="dag-node-"]')).toHaveCount(4)
    const nodeA = page.getByTestId('dag-node-T-A')
    await expect(nodeA.locator('b')).toContainText('A')
    await expect(nodeA).toContainText('执行中')
    await expect(nodeA).toContainText('coder')
    const nodeC = page.getByTestId('dag-node-T-C')
    await expect(nodeC).toContainText('已完成')
    await expect(nodeC).toContainText('reviewer')
  })

  test('nodes: 状态点颜色映射（RUNNING 蓝 / COMPLETED 绿 / FAILED 红）', async ({ page }) => {
    await openDagPage(page, {
      dag_id: 'D1',
      status: 'running',
      tasks: [
        { id: 'T-A', description: '运行', status: 'RUNNING', dependencies: [] },
        { id: 'T-B', description: '完成', status: 'COMPLETED', dependencies: ['T-A'] },
        { id: 'T-C', description: '失败', status: 'FAILED', dependencies: ['T-B'] },
      ],
      edges: [],
    })
    const colors = await page.evaluate(() => {
      const dot = (id: string) => {
        const el = document.querySelector(`[data-testid="dag-node-${id}"] .weave-dag-node-dot`) as HTMLElement | null
        return el ? getComputedStyle(el).backgroundColor : ''
      }
      return { a: dot('T-A'), b: dot('T-B'), c: dot('T-C') }
    })
    expect(colors.a).toBe('rgb(22, 119, 255)') // #1677ff
    expect(colors.b).toBe('rgb(82, 196, 26)') // #52c41a
    expect(colors.c).toBe('rgb(245, 34, 45)') // #f5222d
  })

  test('edges: 贝塞尔 path 锚定节点盒右/左边缘中线（几何即数据）', async ({ page }) => {
    await openDagPage(page, DIAMOND_DAG)
    const svg = page.getByTestId('dag-edges')
    await expect(svg.locator('path')).toHaveCount(4)

    // 解析 d="M x1 y1C..." 起点应=源节点右边缘中线，终点=目标节点左边缘中线
    const geo = await page.evaluate(() => {
      const canvasBox = (document.querySelector('[data-testid="dag-canvas"]') as HTMLElement).getBoundingClientRect()
      const box = (id: string) => {
        const rect = (document.querySelector(`[data-testid="dag-node-${id}"]`) as HTMLElement).getBoundingClientRect()
        return { left: rect.left - canvasBox.left, right: rect.right - canvasBox.left, midY: rect.top - canvasBox.top + rect.height / 2 }
      }
      const el = document.querySelector('[data-testid="dag-edges"] path[data-edge="T-A->T-B"]') as SVGPathElement | null
      const nums = (el?.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
      return {
        d: el?.getAttribute('d') ?? '',
        x1: nums[0] ?? NaN,
        y1: nums[1] ?? NaN,
        x2: nums[nums.length - 2] ?? NaN,
        y2: nums[nums.length - 1] ?? NaN,
        from: box('T-A'),
        to: box('T-B'),
      }
    })
    expect(geo.d).toMatch(/^M[\d.]+ [\d.]+C[\d.]+ [\d.]+,[\d.]+ [\d.]+,[\d.]+ [\d.]+$/)
    expect(Math.abs(geo.x1 - geo.from.right)).toBeLessThanOrEqual(1)
    expect(Math.abs(geo.y1 - geo.from.midY)).toBeLessThanOrEqual(1)
    expect(Math.abs(geo.x2 - geo.to.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(geo.y2 - geo.to.midY)).toBeLessThanOrEqual(1)
  })

  test('edges: 无显式 edges 时从 dependencies 推导（链式）', async ({ page }) => {
    await openDagPage(page, chainScenario(6, false))
    await expect(page.getByTestId('dag-edges').locator('path')).toHaveCount(5)
  })

  test('layout: 列=依赖深度（列距 118），行内同级 y 相同；画布=内容精确尺寸', async ({ page }) => {
    await openDagPage(page, DIAMOND_DAG)
    const geo = await page.evaluate(() => {
      const canvas = document.querySelector('[data-testid="dag-canvas"]') as HTMLElement
      const box = (id: string) => {
        const el = document.querySelector(`[data-testid="dag-node-${id}"]`) as HTMLElement
        return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
      }
      return {
        // 画布 minWidth:100% 会拉伸 offsetWidth，内容尺寸以内联 style 为准（几何即数据）
        styleW: canvas.style.width,
        styleH: canvas.style.height,
        a: box('T-A'),
        b: box('T-B'),
        c: box('T-C'),
        d: box('T-D'),
      }
    })
    // 节点固定 92×30；列距 118（92+26）、行距 38（30+8）
    expect(geo.a.w).toBe(92)
    expect(geo.a.h).toBe(30)
    expect(geo.b.x - geo.a.x).toBe(118)
    expect(geo.d.x - geo.b.x).toBe(118)
    expect(geo.b.x).toBe(geo.c.x)
    expect(Math.abs(geo.c.y - geo.b.y)).toBe(38)
    expect(geo.b.y).toBe(geo.a.y)
    // 画布内容尺寸 = 3 列 × 92 + 2 × 26 = 328 宽；2 行 × 30 + 8 = 68 高
    expect(geo.styleW).toBe('328px')
    expect(geo.styleH).toBe('68px')
  })

  test('focus: 默认派生选中不暗化（全图 data-dimmed=false）', async ({ page }) => {
    await openDagPage(page, DIAMOND_DAG)
    const dimmed = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-testid^="dag-node-"]')]
      const edges = [...document.querySelectorAll('[data-testid="dag-edges"] path')]
      return {
        nodeDimmed: nodes.filter((el) => el.getAttribute('data-dimmed') === 'true').length,
        edgeDimmed: edges.filter((el) => el.getAttribute('data-dimmed') === 'true').length,
        edgeActive: edges.filter((el) => el.getAttribute('data-active') === 'true').length,
      }
    })
    expect(dimmed.nodeDimmed).toBe(0)
    expect(dimmed.edgeDimmed).toBe(0)
    expect(dimmed.edgeActive).toBe(0)
  })

  test('focus: 点选节点固定聚焦上下游链，无关节点/边暗化', async ({ page }) => {
    await openDagPage(page, DIAMOND_DAG)
    // 点选 T-B：related = {T-A, T-B, T-D}；T-C 及其两条边暗化
    await page.getByTestId('dag-node-T-B').click()
    await expect(page.getByTestId('dag-node-T-B')).toHaveAttribute('data-focused', 'true')
    await expect(page.getByTestId('dag-node-T-B')).toHaveAttribute('data-selected', 'true')
    await expect(page.getByTestId('dag-node-T-A')).toHaveAttribute('data-focused', 'true')
    await expect(page.getByTestId('dag-node-T-D')).toHaveAttribute('data-focused', 'true')
    await expect(page.getByTestId('dag-node-T-C')).toHaveAttribute('data-dimmed', 'true')
    await expect(page.getByTestId('dag-node-T-C')).toHaveAttribute('data-focused', 'false')

    const edges = await page.evaluate(() => {
      const read = (edge: string) => {
        const el = document.querySelector(`[data-testid="dag-edges"] path[data-edge="${edge}"]`)!
        return { active: el.getAttribute('data-active'), dimmed: el.getAttribute('data-dimmed') }
      }
      return { ab: read('T-A->T-B'), ac: read('T-A->T-C'), bd: read('T-B->T-D'), cd: read('T-C->T-D') }
    })
    expect(edges.ab).toEqual({ active: 'true', dimmed: 'false' })
    expect(edges.bd).toEqual({ active: 'true', dimmed: 'false' })
    expect(edges.ac).toEqual({ active: 'false', dimmed: 'true' })
    expect(edges.cd).toEqual({ active: 'false', dimmed: 'true' })

    // 暗化是可见样式：opacity 0.3（有 140ms 过渡动画，轮询等待过渡到位）
    await expect
      .poll(
        async () => Number(await page.getByTestId('dag-node-T-C').evaluate((el) => getComputedStyle(el).opacity)),
        { timeout: 5_000 },
      )
      .toBeCloseTo(0.3, 4)
  })

  test('focus: 再点已选节点取消固定，Esc 解除，指针移开后回到干净态', async ({ page }) => {
    await openDagPage(page, DIAMOND_DAG)
    await page.getByTestId('dag-node-T-B').click()
    await expect(page.getByTestId('dag-node-T-C')).toHaveAttribute('data-dimmed', 'true')
    // 再点同一节点 → 取消选中；指针移开后悬停聚焦也解除
    await page.getByTestId('dag-node-T-B').click()
    await expect(page.getByTestId('dag-node-T-B')).toHaveAttribute('data-selected', 'false')
    await page.mouse.move(10, 10) // 离开节点：悬停瞬态聚焦清除
    await expect(page.getByTestId('dag-node-T-C')).toHaveAttribute('data-dimmed', 'false', { timeout: 5_000 })

    // 点选后 Esc → 解除固定；指针已离开节点，暗化随之消失
    await page.getByTestId('dag-node-T-B').click()
    await expect(page.getByTestId('dag-node-T-C')).toHaveAttribute('data-dimmed', 'true')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('dag-node-T-B')).toHaveAttribute('data-selected', 'false')
    await page.mouse.move(10, 10)
    await expect(page.getByTestId('dag-node-T-C')).toHaveAttribute('data-dimmed', 'false', { timeout: 5_000 })
  })

  test('scroll: 40 节点长链画布 4714px 宽 → wrap 横向滚动可用', async ({ page }) => {
    await openDagPage(page, chainScenario(40, true))
    await expect(page.locator('[data-testid^="dag-node-"]')).toHaveCount(40)
    await expect(page.getByTestId('dag-edges').locator('path')).toHaveCount(39)
    const metrics = await page.evaluate(() => {
      const wrap = document.querySelector('[data-testid="dag-panel"]') as HTMLElement
      const canvas = document.querySelector('[data-testid="dag-canvas"]') as HTMLElement
      return {
        overflowX: getComputedStyle(wrap).overflowX,
        scrollWidth: wrap.scrollWidth,
        clientWidth: wrap.clientWidth,
        canvasW: canvas.offsetWidth,
      }
    })
    expect(metrics.overflowX).toBe('auto')
    expect(metrics.canvasW).toBe(40 * 92 + 39 * 26) // 4714
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="dag-panel"]') as HTMLElement
      el.scrollLeft = 400
    })
    const scrolled = await page.evaluate(() => (document.querySelector('[data-testid="dag-panel"]') as HTMLElement).scrollLeft)
    expect(scrolled).toBeGreaterThan(0)
  })
})
