import { test } from '@playwright/test'
test('dag dom detail', async ({ page }) => {
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle' })
  await page.locator('text=启用下团队长安').first().click({ timeout: 5000 })
  await page.waitForTimeout(3000)
  await page.locator('text=Weave 团队').first().click({ timeout: 5000 })
  await page.waitForTimeout(5000)
  // 直接查 dag-panel 的存在和尺寸
  const panel = page.locator('[data-testid="dag-panel"]')
  const exists = await panel.count()
  if (exists > 0) {
    const box = await panel.boundingBox()
    console.log('dag-panel exists:', exists, 'boundingBox:', JSON.stringify(box))
    const nodes = await page.locator('[data-testid^="dag-node-"]').count()
    console.log('dag-nodes:', nodes)
  } else {
    console.log('dag-panel NOT FOUND')
  }
  // 查整个会话面板的完整 HTML 结构里 dag 相关的部分
  const dagHtml = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="dag-panel"]')
    return el ? { found: true, tag: el.tagName, children: el.children.length, w: el.offsetWidth, h: el.offsetHeight } : { found: false }
  })
  console.log('dag DOM:', JSON.stringify(dagHtml))
})
