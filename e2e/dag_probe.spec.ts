import { test } from '@playwright/test'
test('DAG panel check', async ({ page }) => {
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle' })
  // 点进最近会话"启用下团队长安"
  const sess = page.locator('text=启用下团队长安').first()
  await sess.click({ timeout: 5000 })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: '.artifacts/dag-01-session.png', fullPage: true })
  // 滚到底部找 WeaveSessionPanel
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '.artifacts/dag-02-bottom.png', fullPage: true })
  const dagVisible = await page.locator('[data-testid="weave-session-task-detail"]').isVisible().catch(()=>false)
  const svgDag = await page.locator('svg circle, svg rect').count()
  const emptyState = await page.getByText('暂无任务').isVisible().catch(()=>false)
  console.log('dag_detail_visible:', dagVisible, '| svg_nodes:', svgDag, '| empty_state:', emptyState)
})
