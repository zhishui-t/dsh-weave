import { test } from '@playwright/test'
test('dag visual verify', async ({ page }) => {
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle' })
  await page.locator('text=启用下团队长安').first().click({ timeout: 5000 })
  await page.waitForTimeout(3000)
  await page.locator('text=Weave 团队').first().click({ timeout: 5000 })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: '.artifacts/dag-fixed.png', fullPage: true })
})
