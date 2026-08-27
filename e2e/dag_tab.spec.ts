import { test } from '@playwright/test'
test('weave team tab dag', async ({ page }) => {
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle' })
  const sess = page.locator('text=启用下团队长安').first()
  await sess.click({ timeout: 5000 })
  await page.waitForTimeout(3000)
  // 点「Weave 团队」tab
  const tab = page.locator('text=Weave 团队').first()
  await tab.click({ timeout: 5000 })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: '.artifacts/dag-tab-view.png', fullPage: true })
})
