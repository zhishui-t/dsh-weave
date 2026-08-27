import { test } from '@playwright/test'
test('dag svg check', async ({ page }) => {
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle' })
  const sess = page.locator('text=启用下团队长安').first()
  await sess.click({ timeout: 5000 })
  await page.waitForTimeout(3000)
  await page.locator('text=Weave 团队').first().click({ timeout: 5000 })
  await page.waitForTimeout(5000)
  // 专查 DagGraph 的 SVG
  const dagSvg = page.locator('.weave-dag, svg.weave-dag, [class*="dag"]')
  const count = await dagSvg.count()
  const svgCount = await page.locator('svg').count()
  // 检查 DagGraph 特有的 class 或元素
  const dagNodes = await page.locator('[class*="dag-node"], [data-dag-node], circle[r]').count()
  // 查看任务图区域的 innerHTML
  const dagArea = await page.locator('text=本会话任务图').locator('..').innerHTML().catch(() => 'NOT_FOUND')
  console.log('dag_elements:', count, '| total_svg:', svgCount, '| dag_nodes:', dagNodes)
  console.log('dag_area_html_len:', dagArea.length)
  console.log('dag_area_snippet:', dagArea.slice(0, 500))
})
